/**
 * Teklif ve fiyat koşulu deposu.
 *
 * TEKLİF SİPARİŞE DÖNÜŞÜRKEN FİYAT DONDURULUR. Sipariş anında yeniden
 * hesaplansaydı, müşteriye verilen teklifle kesilen fatura arasında fark
 * doğar ve fark her zaman müşterinin aleyhine olduğunda fark edilirdi.
 *
 * SÜRESİ GEÇEN TEKLİF SİPARİŞE DÖNÜŞEMEZ. Dönüşseydi, üç ay önceki bir
 * fiyat bugünkü maliyetle karşılanmak zorunda kalırdı.
 */

import { Prisma } from "./generated/tenant/index.js";
import type { TenantDb } from "./client.js";
import { nextDocumentNo } from "./sales-repository.js";
import {
  priceFor,
  PricingConditionError,
  type Condition,
  type PriceResult,
  type PricingRequest,
} from "../modules/sales/pricing-conditions.js";
import { documentTotals, fromKurus, priceLine } from "../modules/sales/pricing.js";

export class QuotationError extends Error {
  readonly code = "quotation";
  constructor(message: string) {
    super(message);
    this.name = "QuotationError";
  }
}

export class QuotationRepository {
  readonly #db: TenantDb;

  constructor(db: TenantDb) {
    this.#db = db;
  }

  // ─── Fiyat koşulları ───

  async conditions(itemCode: string, partnerId: string): Promise<readonly Condition[]> {
    const rows = await this.#db.priceCondition.findMany({
      where: {
        isActive: true,
        OR: [{ itemCode }, { itemCode: null }],
        AND: [{ OR: [{ partnerId }, { partnerId: null }] }],
      },
      take: 500,
    });
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind as Condition["kind"],
      partnerId: r.partnerId,
      itemCode: r.itemCode,
      partnerGroup: r.partnerGroup,
      minQuantity: Number(r.minQuantity),
      currency: r.currency,
      value: Number(r.value),
      validFrom: r.validFrom,
      validTo: r.validTo,
      priority: r.priority,
    }));
  }

  /** Bir kalem için fiyat hesaplar — hangi koşuldan geldiğiyle birlikte. */
  async price(req: PricingRequest): Promise<PriceResult> {
    const conds = await this.conditions(req.itemCode, req.partnerId);
    return priceFor(conds, req);
  }

  async saveCondition(input: {
    kind: Condition["kind"];
    partnerId?: string | null;
    itemCode?: string | null;
    partnerGroup?: string | null;
    minQuantity?: number;
    currency: string;
    value: number;
    validFrom: Date;
    validTo?: Date | null;
    priority?: number;
  }): Promise<{ id: string }> {
    if (input.value < 0) {
      throw new PricingConditionError(
        "Koşul değeri negatif olamaz. Negatif iskonto bir zamdır ve adı yanlış " +
          "olduğu için kimse fark etmez.",
      );
    }
    const row = await this.#db.priceCondition.create({
      data: {
        kind: input.kind,
        partnerId: input.partnerId ?? null,
        itemCode: input.itemCode ?? null,
        partnerGroup: input.partnerGroup ?? null,
        minQuantity: new Prisma.Decimal(input.minQuantity ?? 0),
        currency: input.currency,
        value: new Prisma.Decimal(input.value),
        validFrom: input.validFrom,
        validTo: input.validTo ?? null,
        priority: input.priority ?? 0,
      },
    });
    return { id: row.id };
  }

  // ─── Satış teklifi ───

  async createQuotation(input: {
    partnerId: string;
    quotedAt: Date;
    validUntil: Date;
    currency?: string;
    userId: string;
    note?: string | null;
    lines: readonly {
      itemCode: string;
      quantity: number;
      uom: string;
      /** Verilmezse fiyat koşullarından HESAPLANIR. */
      unitPrice?: number | null;
      vatRate?: number;
    }[];
  }): Promise<{ documentNo: string; totalAmount: number; caveats: readonly string[] }> {
    if (input.lines.length === 0) {
      throw new QuotationError("Teklif en az bir kalem içermelidir.");
    }
    if (input.validUntil < input.quotedAt) {
      throw new QuotationError("Geçerlilik tarihi teklif tarihinden önce olamaz.");
    }

    const currency = input.currency ?? "TRY";
    const caveats: string[] = [];

    return this.#db.$transaction(async (tx) => {
      const documentNo = await nextDocumentNo(
        tx,
        "sales_quotation",
        input.quotedAt.getUTCFullYear(),
      );

      const priced: {
        lineNo: number;
        itemCode: string;
        quantity: number;
        uom: string;
        unitPrice: number;
        discountPercent: number;
        vatRate: number;
      }[] = [];

      let lineNo = 0;
      for (const l of input.lines) {
        lineNo += 1;
        let unitPrice = l.unitPrice ?? null;
        let discountPercent = 0;

        if (unitPrice === null) {
          const r = await this.price({
            itemCode: l.itemCode,
            partnerId: input.partnerId,
            quantity: l.quantity,
            currency,
            on: input.quotedAt,
          });
          unitPrice = r.unitPrice;
          discountPercent = r.discountPercent;
          if (r.caveat) caveats.push(`Kalem ${lineNo}: ${r.caveat}`);
        }

        // FİYATSIZ TEKLİF VERİLMEZ. Sıfır fiyat "bedava" demektir ve
        // müşteri onu kabul ederse bağlayıcı olur.
        if (unitPrice === null || unitPrice <= 0) {
          throw new QuotationError(
            `Kalem ${lineNo} (${l.itemCode}) için fiyat bulunamadı ve girilmedi. ` +
              `Fiyatsız teklif verilemez; müşteri kabul ederse sıfır fiyat bağlayıcı olur.`,
          );
        }

        priced.push({
          lineNo,
          itemCode: l.itemCode,
          quantity: l.quantity,
          uom: l.uom,
          unitPrice,
          discountPercent,
          vatRate: l.vatRate ?? 20,
        });
      }

      await tx.salesQuotation.create({
        data: {
          documentNo,
          partnerId: input.partnerId,
          quotedAt: input.quotedAt,
          validUntil: input.validUntil,
          currency,
          status: "draft",
          note: input.note ?? null,
          createdBy: input.userId,
          lines: {
            create: priced.map((p) => ({
              lineNo: p.lineNo,
              itemId: p.itemCode,
              quantity: new Prisma.Decimal(p.quantity),
              uom: p.uom,
              unitPrice: new Prisma.Decimal(p.unitPrice),
              discountPercent: new Prisma.Decimal(p.discountPercent),
              vatRate: p.vatRate,
            })),
          },
        },
      });

      const totals = documentTotals(
        priced.map((p) => ({
          vatRate: p.vatRate,
          amounts: priceLine({
            quantity: p.quantity,
            unitPrice: p.unitPrice,
            discountPercent: p.discountPercent,
            vatRate: p.vatRate,
          }),
        })),
      );

      return { documentNo, totalAmount: fromKurus(totals.totalKurus), caveats };
    });
  }

  async quotationByNo(documentNo: string) {
    const row = await this.#db.salesQuotation.findUnique({
      where: { documentNo },
      include: { lines: { orderBy: { lineNo: "asc" } } },
    });
    if (!row) return null;

    const totals = documentTotals(
      row.lines.map((l) => ({
        vatRate: l.vatRate,
        amounts: priceLine({
          quantity: Number(l.quantity),
          unitPrice: Number(l.unitPrice),
          discountPercent: Number(l.discountPercent),
          vatRate: l.vatRate,
        }),
      })),
    );

    return {
      documentNo: row.documentNo,
      partnerId: row.partnerId,
      quotedAt: row.quotedAt.toISOString().slice(0, 10),
      validUntil: row.validUntil.toISOString().slice(0, 10),
      status: row.status,
      currency: row.currency,
      salesOrderNo: row.salesOrderNo,
      lines: row.lines.map((l) => ({
        lineNo: l.lineNo,
        itemCode: l.itemId,
        quantity: Number(l.quantity),
        uom: l.uom,
        unitPrice: Number(l.unitPrice),
        discountPercent: Number(l.discountPercent),
        vatRate: l.vatRate,
      })),
      netAmount: fromKurus(totals.netKurus),
      totalAmount: fromKurus(totals.totalKurus),
    };
  }

  /**
   * Teklifi siparişe dönüştürür.
   *
   * FİYAT DONDURULUR: teklifteki fiyat aynen siparişe geçer. Yeniden
   * hesaplansaydı, müşteriye verilen sözle kesilen fatura arasında fark
   * doğardı.
   */
  async convertToOrder(input: {
    documentNo: string;
    orderNo: string;
    committedDate: Date;
    on: Date;
  }): Promise<{ orderNo: string; lines: number }> {
    return this.#db.$transaction(async (tx) => {
      const q = await tx.salesQuotation.findUnique({
        where: { documentNo: input.documentNo },
        include: { lines: { orderBy: { lineNo: "asc" } } },
      });
      if (!q) throw new QuotationError(`Teklif bulunamadı: ${input.documentNo}`);
      if (q.status === "ordered") {
        throw new QuotationError(`${input.documentNo} zaten siparişe dönüştürülmüş.`);
      }
      if (q.status === "rejected" || q.status === "cancelled") {
        throw new QuotationError(`${input.documentNo} ${q.status} durumunda; dönüştürülemez.`);
      }

      // SÜRESİ GEÇEN TEKLİF SİPARİŞE DÖNÜŞEMEZ. Dönüşseydi, üç ay önceki
      // bir fiyat bugünkü maliyetle karşılanmak zorunda kalırdı.
      if (q.validUntil < input.on) {
        throw new QuotationError(
          `${input.documentNo} teklifinin geçerliliği ` +
            `${q.validUntil.toISOString().slice(0, 10)} tarihinde doldu. ` +
            `Süresi geçmiş fiyat bugünkü maliyetle karşılanamaz; teklif yenilenmelidir.`,
        );
      }

      await tx.salesOrder.create({
        data: {
          orderNo: input.orderNo,
          partnerId: q.partnerId,
          committedDate: input.committedDate,
          currency: q.currency,
          lines: {
            create: q.lines.map((l) => ({
              lineNo: l.lineNo,
              itemId: l.itemId,
              uom: l.uom,
              quantity: l.quantity,
              unitPrice: l.unitPrice,
              discountPercent: l.discountPercent,
              vatRate: l.vatRate,
            })),
          },
        },
      });

      await tx.salesQuotation.update({
        where: { id: q.id },
        data: { status: "ordered", salesOrderNo: input.orderNo },
      });

      return { orderNo: input.orderNo, lines: q.lines.length };
    });
  }

  async setQuotationStatus(
    documentNo: string,
    status: "sent" | "accepted" | "rejected" | "expired",
    reason?: string | null,
  ): Promise<void> {
    const q = await this.#db.salesQuotation.findUnique({ where: { documentNo } });
    if (!q) throw new QuotationError(`Teklif bulunamadı: ${documentNo}`);
    if (q.status === "ordered") {
      throw new QuotationError("Siparişe dönüşmüş teklifin durumu değiştirilemez.");
    }
    if (status === "rejected" && (!reason || reason.trim().length < 3)) {
      throw new QuotationError(
        "Ret sebebi yazılmalıdır. Dönüşüm oranını iyileştiren tek veri budur; " +
          "sebepsiz reddedilen teklifler bir sonraki teklifi de kaybettirir.",
      );
    }
    await this.#db.salesQuotation.update({
      where: { id: q.id },
      data: { status, rejectionReason: reason ?? null },
    });
  }

  /**
   * Teklif dönüşüm oranı.
   *
   * Bir satış organizasyonunun en temel ölçüsü budur ve teklif kaydı
   * olmadan hiçbir yerde hesaplanamaz.
   */
  async conversionRate(from: Date, to: Date) {
    const rows = await this.#db.salesQuotation.groupBy({
      by: ["status"],
      where: { quotedAt: { gte: from, lte: to } },
      _count: { _all: true },
    });
    const byStatus = new Map(rows.map((r) => [r.status, r._count._all]));
    const total = [...byStatus.values()].reduce((s, n) => s + n, 0);
    const ordered = byStatus.get("ordered") ?? 0;
    const rejected = byStatus.get("rejected") ?? 0;

    // En sık ret sebepleri — dönüşümü iyileştirecek tek bilgi.
    const reasons = await this.#db.salesQuotation.findMany({
      where: { quotedAt: { gte: from, lte: to }, status: "rejected", rejectionReason: { not: null } },
      select: { rejectionReason: true },
      take: 200,
    });
    const reasonCount = new Map<string, number>();
    for (const r of reasons) {
      const key = r.rejectionReason!.trim();
      reasonCount.set(key, (reasonCount.get(key) ?? 0) + 1);
    }

    return {
      total,
      ordered,
      rejected,
      pending: total - ordered - rejected,
      conversionPercent: total === 0 ? null : Math.round((ordered / total) * 1000) / 10,
      topRejectionReasons: [...reasonCount.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([reason, count]) => ({ reason, count })),
    };
  }

  // ─── Satın alma teklif talebi ───

  async createRfq(input: {
    requestedAt: Date;
    dueDate: Date;
    requisitionNo?: string | null;
    userId: string;
  }): Promise<{ documentNo: string }> {
    return this.#db.$transaction(async (tx) => {
      const documentNo = await nextDocumentNo(
        tx,
        "purchase_rfq",
        input.requestedAt.getUTCFullYear(),
      );
      await tx.purchaseRfq.create({
        data: {
          documentNo,
          requisitionNo: input.requisitionNo ?? null,
          requestedAt: input.requestedAt,
          dueDate: input.dueDate,
          status: "open",
          createdBy: input.userId,
        },
      });
      return { documentNo };
    });
  }

  async recordQuote(input: {
    rfqNo: string;
    partnerId: string;
    totalAmount: number;
    currency?: string;
    leadTimeDays?: number | null;
    validUntil?: Date | null;
    note?: string | null;
    receivedAt: Date;
  }): Promise<void> {
    const rfq = await this.#db.purchaseRfq.findUnique({ where: { documentNo: input.rfqNo } });
    if (!rfq) throw new QuotationError(`Teklif talebi bulunamadı: ${input.rfqNo}`);
    if (rfq.status !== "open") {
      throw new QuotationError(`${input.rfqNo} ${rfq.status} durumunda; yeni teklif alınamaz.`);
    }

    await this.#db.supplierQuote.upsert({
      where: { rfqId_partnerId: { rfqId: rfq.id, partnerId: input.partnerId } },
      create: {
        rfqId: rfq.id,
        partnerId: input.partnerId,
        totalAmount: new Prisma.Decimal(input.totalAmount),
        currency: input.currency ?? "TRY",
        leadTimeDays: input.leadTimeDays ?? null,
        validUntil: input.validUntil ?? null,
        note: input.note ?? null,
        receivedAt: input.receivedAt,
      },
      update: {
        totalAmount: new Prisma.Decimal(input.totalAmount),
        leadTimeDays: input.leadTimeDays ?? null,
        note: input.note ?? null,
        receivedAt: input.receivedAt,
      },
    });
  }

  /**
   * Teklif karşılaştırması.
   *
   * EN UCUZ HER ZAMAN EN İYİ DEĞİLDİR: 5 gün geç gelen %3 ucuz teklif,
   * üretimi durduracaksa pahalıdır. Bu yüzden teslim süresi de yan yana
   * gösterilir ve karar insana bırakılır.
   */
  async compareQuotes(rfqNo: string) {
    const rfq = await this.#db.purchaseRfq.findUnique({
      where: { documentNo: rfqNo },
      include: { quotes: { orderBy: { totalAmount: "asc" } } },
    });
    if (!rfq) throw new QuotationError(`Teklif talebi bulunamadı: ${rfqNo}`);

    const quotes = rfq.quotes.map((q) => ({
      partnerId: q.partnerId,
      totalAmount: Number(q.totalAmount),
      currency: q.currency,
      leadTimeDays: q.leadTimeDays,
      receivedAt: q.receivedAt.toISOString().slice(0, 10),
    }));

    const cheapest = quotes[0] ?? null;
    const fastest = [...quotes]
      .filter((q) => q.leadTimeDays !== null)
      .sort((a, b) => a.leadTimeDays! - b.leadTimeDays!)[0] ?? null;

    return {
      documentNo: rfqNo,
      status: rfq.status,
      quotes,
      cheapest,
      fastest,
      // TEK TEKLİF KARŞILAŞTIRMA DEĞİLDİR.
      comparable: quotes.length >= 2,
      spread:
        quotes.length >= 2
          ? Math.round((quotes[quotes.length - 1]!.totalAmount - quotes[0]!.totalAmount) * 100) / 100
          : null,
    };
  }

  /**
   * Kazanan teklifi seçer.
   *
   * EN UCUZ SEÇİLMEDİYSE GEREKÇE ZORUNLUDUR. Gerekçesiz bir tercih,
   * denetimde açıklanamayan bir karardır ve satın almadaki en yaygın
   * suistimal alanıdır.
   */
  async award(input: {
    rfqNo: string;
    partnerId: string;
    reason?: string | null;
  }): Promise<{ awarded: string; wasCheapest: boolean }> {
    const comparison = await this.compareQuotes(input.rfqNo);
    const chosen = comparison.quotes.find((q) => q.partnerId === input.partnerId);
    if (!chosen) {
      throw new QuotationError(
        `${input.partnerId} bu teklif talebine teklif vermemiş; seçilemez.`,
      );
    }

    const wasCheapest = comparison.cheapest?.partnerId === input.partnerId;
    if (!wasCheapest && (!input.reason || input.reason.trim().length < 5)) {
      throw new QuotationError(
        `En ucuz teklif ${comparison.cheapest?.partnerId} firmasından ` +
          `(${comparison.cheapest?.totalAmount}); başka bir tedarikçi seçiliyorsa GEREKÇE ` +
          `zorunludur. Gerekçesiz tercih, denetimde açıklanamayan bir karardır.`,
      );
    }

    const rfq = await this.#db.purchaseRfq.findUniqueOrThrow({
      where: { documentNo: input.rfqNo },
      include: { quotes: true },
    });
    const quote = rfq.quotes.find((q) => q.partnerId === input.partnerId)!;

    await this.#db.purchaseRfq.update({
      where: { id: rfq.id },
      data: {
        status: "awarded",
        awardedQuoteId: quote.id,
        awardReason: input.reason ?? "En düşük teklif",
      },
    });

    return { awarded: input.partnerId, wasCheapest };
  }
}
