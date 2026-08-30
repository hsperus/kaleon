/**
 * Satış iadesi ve dekontlar.
 *
 * KESİLMİŞ FATURA İPTAL EDİLMEZ, İADE EDİLİR. İkisi denetimde aynı şey
 * değildir: iptal "bu satış hiç olmadı" der, iade "oldu ve geri döndü"
 * der. Bu sistemde fatura zaten değiştirilemez; iade olmadan tek çare
 * faturayı iptal etmekti ve o da yanlıştı.
 *
 * ÜÇ BELGE, ÜÇ AYRI MUHASEBE:
 *   iade            → mal geri gelir: stok girer, 610 borçlanır
 *   alacak_dekontu  → mal gelmez, fiyat düşer: 611 borçlanır
 *   borc_dekontu    → müşteriye ek yansıtma: 600 alacaklanır
 *
 * 600 TERS YAZILMAZ. Satış hesabını ters yazmak ciroyu düşürür ve "bu
 * yıl ne kadar sattık" sorusunun cevabını bozar; iade ayrı hesapta
 * durunca iade ORANI da ölçülebilir olur — ki bu, kalite sorununun
 * en erken göstergesidir.
 */

import { Prisma } from "./generated/tenant/index.js";
import type { TenantDb } from "./client.js";
import { nextDocumentNo } from "./sales-repository.js";
import { JournalRepository } from "./journal-repository.js";

export type NoteKind = "iade" | "alacak_dekontu" | "borc_dekontu";

export class CreditNoteError extends Error {
  readonly code = "credit_note";
  constructor(message: string) {
    super(message);
    this.name = "CreditNoteError";
  }
}

export interface NoteLineInput {
  /** Hangi fatura satırından — iadede ZORUNLU, dekontta isteğe bağlı. */
  readonly invoiceLineNo?: number | null;
  readonly quantity: number;
  /** Dekontta serbest tutar; iadede fatura fiyatı kullanılır. */
  readonly unitPrice?: number | null;
  readonly description?: string | null;
  readonly vatRate?: number | null;
}

export interface NoteView {
  readonly documentNo: string;
  readonly kind: NoteKind;
  readonly issuedAt: string;
  readonly partnerName: string;
  readonly invoiceNo: string | null;
  readonly currency: string;
  readonly netAmount: number;
  readonly vatAmount: number;
  readonly totalAmount: number;
  readonly withGoods: boolean;
  readonly reason: string;
  readonly status: string;
  readonly journalDocumentNo: string | null;
  readonly lines: readonly {
    lineNo: number;
    description: string;
    quantity: number;
    uom: string;
    unitPrice: number;
    netAmount: number;
    vatRate: number;
    vatAmount: number;
  }[];
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
const num = (v: unknown): number => Number(v ?? 0);

/** İade/dekont türüne göre gelir tablosu hesabı. */
export function accountFor(kind: NoteKind): string {
  switch (kind) {
    case "iade":
      return "610"; // Satıştan İadeler
    case "alacak_dekontu":
      return "611"; // Satış İskontoları
    case "borc_dekontu":
      return "600"; // Ek yansıtma gerçek bir satıştır
  }
}

export class CreditNoteRepository {
  readonly #db: TenantDb;

  constructor(db: TenantDb) {
    this.#db = db;
  }

  async byDocumentNo(documentNo: string): Promise<NoteView | null> {
    const n = await this.#db.salesCreditNote.findUnique({
      where: { documentNo },
      include: { lines: { orderBy: { lineNo: "asc" } }, invoice: { select: { documentNo: true } } },
    });
    if (!n) return null;
    const partner = await this.#db.partner.findUnique({
      where: { id: n.partnerId },
      select: { legalName: true },
    });
    return {
      documentNo: n.documentNo,
      kind: n.kind as NoteKind,
      issuedAt: n.issuedAt.toISOString(),
      partnerName: partner?.legalName ?? n.partnerId,
      invoiceNo: n.invoice?.documentNo ?? null,
      currency: n.currency,
      netAmount: num(n.netAmount),
      vatAmount: num(n.vatAmount),
      totalAmount: num(n.totalAmount),
      withGoods: n.withGoods,
      reason: n.reason,
      status: n.status,
      journalDocumentNo: n.journalDocumentNo,
      lines: n.lines.map((l) => ({
        lineNo: l.lineNo,
        description: l.description,
        quantity: num(l.quantity),
        uom: l.uom,
        unitPrice: num(l.unitPrice),
        netAmount: num(l.netAmount),
        vatRate: l.vatRate,
        vatAmount: num(l.vatAmount),
      })),
    };
  }

  async listForInvoice(invoiceNo: string): Promise<readonly NoteView[]> {
    const inv = await this.#db.salesInvoice.findUnique({
      where: { documentNo: invoiceNo },
      select: { id: true },
    });
    if (!inv) return [];
    const rows = await this.#db.salesCreditNote.findMany({
      where: { invoiceId: inv.id },
      select: { documentNo: true },
      orderBy: { issuedAt: "asc" },
    });
    const out: NoteView[] = [];
    for (const r of rows) {
      const v = await this.byDocumentNo(r.documentNo);
      if (v) out.push(v);
    }
    return out;
  }

  /**
   * İade ya da dekont keser.
   *
   * AŞIRI İADE ENGELLENİR: bir fatura satırından, faturalanandan fazla
   * iade edilemez. Edilebilseydi cari bakiyesi alacaklı çıkar ve
   * müşteriye borçlu görünürdük.
   */
  async issue(input: {
    kind: NoteKind;
    invoiceNo: string;
    issuedAt: Date;
    reason: string;
    withGoods: boolean;
    locationId?: string | null;
    userId: string;
    lines: readonly NoteLineInput[];
  }): Promise<NoteView> {
    if (input.lines.length === 0) {
      throw new CreditNoteError("Belge en az bir kalem içermelidir.");
    }
    if (input.reason.trim().length < 5) {
      throw new CreditNoteError("İade/dekont gerekçesi yazılmalıdır.");
    }
    if (input.kind === "iade" && input.withGoods && !input.locationId) {
      throw new CreditNoteError(
        "Mal iadesinde depo belirtilmelidir; gelen mal bir yere girmelidir.",
      );
    }

    return this.#db.$transaction(async (tx) => {
      const invoice = await tx.salesInvoice.findUnique({
        where: { documentNo: input.invoiceNo },
        include: { lines: { orderBy: { lineNo: "asc" } } },
      });
      if (!invoice) throw new CreditNoteError(`Fatura bulunamadı: ${input.invoiceNo}`);
      if (invoice.status === "draft") {
        throw new CreditNoteError(
          `${input.invoiceNo} henüz kesilmemiş; kesilmemiş faturaya iade yapılamaz.`,
        );
      }
      if (invoice.status === "cancelled") {
        throw new CreditNoteError(`${input.invoiceNo} iptal edilmiş; iade yapılamaz.`);
      }

      const byLineNo = new Map(invoice.lines.map((l) => [l.lineNo, l]));

      // Daha önce iade edilen miktarlar — aşırı iade kontrolü için.
      const previous = await tx.salesCreditNoteLine.groupBy({
        by: ["invoiceLineNo"],
        where: { note: { invoiceId: invoice.id, status: { not: "cancelled" } } },
        _sum: { quantity: true },
      });
      const already = new Map(
        previous
          .filter((p) => p.invoiceLineNo !== null)
          .map((p) => [p.invoiceLineNo!, num(p._sum.quantity)]),
      );

      let netTotal = 0;
      let vatTotal = 0;
      const drafts: {
        lineNo: number;
        invoiceLineNo: number | null;
        itemId: string | null;
        description: string;
        quantity: number;
        uom: string;
        unitPrice: number;
        netAmount: number;
        vatRate: number;
        vatAmount: number;
        totalAmount: number;
      }[] = [];

      let lineNo = 0;
      for (const l of input.lines) {
        lineNo += 1;
        if (l.quantity <= 0) {
          throw new CreditNoteError(`${lineNo}. kalemde miktar pozitif olmalıdır.`);
        }

        const src = l.invoiceLineNo != null ? byLineNo.get(l.invoiceLineNo) : undefined;
        if (l.invoiceLineNo != null && !src) {
          throw new CreditNoteError(
            `${input.invoiceNo} faturasında ${l.invoiceLineNo}. kalem yok.`,
          );
        }
        // İADE MUTLAKA BİR FATURA SATIRINA BAĞLANIR: bağlanmasaydı ne
        // kadarının iade edildiği hiç bilinemezdi.
        if (input.kind === "iade" && !src) {
          throw new CreditNoteError("İade kalemi bir fatura satırına bağlanmalıdır.");
        }

        if (src) {
          const invoiced = num(src.quantity);
          const returned = already.get(src.lineNo) ?? 0;
          const remaining = round2(invoiced - returned);
          if (l.quantity > remaining + 1e-9) {
            throw new CreditNoteError(
              `${src.lineNo}. kalemde en fazla ${remaining} ${src.uom} iade edilebilir ` +
                `(faturalanan ${invoiced}, daha önce iade ${returned}).`,
            );
          }
        }

        const unitPrice = l.unitPrice ?? (src ? num(src.unitPrice) : 0);
        if (unitPrice <= 0) {
          throw new CreditNoteError(`${lineNo}. kalemde birim fiyat belirlenemedi.`);
        }
        const vatRate = l.vatRate ?? (src ? src.vatRate : 20);
        const net = round2(l.quantity * unitPrice);
        const vat = round2((net * vatRate) / 100);

        netTotal = round2(netTotal + net);
        vatTotal = round2(vatTotal + vat);

        drafts.push({
          lineNo,
          invoiceLineNo: src ? src.lineNo : null,
          itemId: src ? src.itemId : null,
          description: l.description ?? (src ? src.description : `${lineNo}. kalem`),
          quantity: l.quantity,
          uom: src ? src.uom : "adet",
          unitPrice,
          netAmount: net,
          vatRate,
          vatAmount: vat,
          totalAmount: round2(net + vat),
        });
      }

      const total = round2(netTotal + vatTotal);
      const year = input.issuedAt.getUTCFullYear();
      const documentNo = await nextDocumentNo(tx, "sales_credit_note", year);

      const note = await tx.salesCreditNote.create({
        data: {
          documentNo,
          kind: input.kind,
          partnerId: invoice.partnerId,
          invoiceId: invoice.id,
          issuedAt: input.issuedAt,
          currency: invoice.currency,
          exchangeRate: invoice.exchangeRate,
          netAmount: new Prisma.Decimal(netTotal),
          vatAmount: new Prisma.Decimal(vatTotal),
          totalAmount: new Prisma.Decimal(total),
          withGoods: input.withGoods,
          locationId: input.locationId ?? null,
          reason: input.reason,
          status: "issued",
          issuedBy: input.userId,
        },
      });

      for (const d of drafts) {
        await tx.salesCreditNoteLine.create({
          data: {
            noteId: note.id,
            lineNo: d.lineNo,
            invoiceLineNo: d.invoiceLineNo,
            itemId: d.itemId,
            description: d.description,
            quantity: new Prisma.Decimal(d.quantity),
            uom: d.uom,
            unitPrice: new Prisma.Decimal(d.unitPrice),
            netAmount: new Prisma.Decimal(d.netAmount),
            vatRate: d.vatRate,
            vatAmount: new Prisma.Decimal(d.vatAmount),
            totalAmount: new Prisma.Decimal(d.totalAmount),
          },
        });
      }

      /*
       * MUHASEBE KAYDI.
       *
       * İade/alacak dekontunda cari ALACAKLANIR (borcu azalır); borç
       * dekontunda BORÇLANIR. KDV de aynı yönde ters döner: iade
       * edilen malın KDV'si beyan edilen KDV'den düşülür.
       */
      const income = accountFor(input.kind);
      const isCharge = input.kind === "borc_dekontu";
      const lines = isCharge
        ? [
            { accountCode: "120", debit: total, credit: 0, description: `${documentNo} borç dekontu`, partnerId: invoice.partnerId },
            { accountCode: income, debit: 0, credit: netTotal, description: `${documentNo} ek yansıtma` },
            { accountCode: "391", debit: 0, credit: vatTotal, description: `${documentNo} hesaplanan KDV` },
          ]
        : [
            { accountCode: income, debit: netTotal, credit: 0, description: `${documentNo} ${input.kind}` },
            { accountCode: "391", debit: vatTotal, credit: 0, description: `${documentNo} KDV düzeltmesi` },
            { accountCode: "120", debit: 0, credit: total, description: `${documentNo} cari alacak`, partnerId: invoice.partnerId },
          ];

      const entry = await JournalRepository.postIn(tx, {
        entryDate: input.issuedAt,
        description: `${documentNo} ${input.kind.replace("_", " ")}`,
        sourceKind: "sales_invoice",
        sourceId: note.id,
        userId: input.userId,
        lines: lines.filter((l) => l.debit > 0 || l.credit > 0),
      });

      await tx.salesCreditNote.update({
        where: { id: note.id },
        data: { journalDocumentNo: entry.documentNo },
      });

      /*
       * STOK GİRİŞİ — yalnızca mal geri geldiyse.
       *
       * ALACAK DEKONTUNDA STOK HAREKETİ OLMAZ: fiyat düzeltmesi malın
       * yerini değiştirmez. Yazılsaydı depoda olmayan mal görünürdü.
       */
      if (input.withGoods && input.locationId) {
        for (const d of drafts) {
          if (!d.itemId) continue;
          const mv = await tx.stockMovement.create({
            data: {
              at: input.issuedAt,
              itemId: d.itemId,
              locationId: input.locationId,
              quantity: new Prisma.Decimal(d.quantity),
              // +1: iade edilen mal depoya GİRER.
              direction: 1,
              movementType: "satis_iadesi",
              referenceKind: "sales_credit_note",
              referenceId: note.id,
              userId: input.userId,
              reason: `${documentNo} iadesi`,
            },
          });
          await tx.salesCreditNoteLine.update({
            where: { noteId_lineNo: { noteId: note.id, lineNo: d.lineNo } },
            data: { movementId: mv.id },
          });
        }
      }

      const partner = await tx.partner.findUnique({
        where: { id: invoice.partnerId },
        select: { legalName: true },
      });

      return {
        documentNo,
        kind: input.kind,
        issuedAt: input.issuedAt.toISOString(),
        partnerName: partner?.legalName ?? invoice.partnerId,
        invoiceNo: invoice.documentNo,
        currency: invoice.currency,
        netAmount: netTotal,
        vatAmount: vatTotal,
        totalAmount: total,
        withGoods: input.withGoods,
        reason: input.reason,
        status: "issued",
        journalDocumentNo: entry.documentNo,
        lines: drafts.map((d) => ({
          lineNo: d.lineNo,
          description: d.description,
          quantity: d.quantity,
          uom: d.uom,
          unitPrice: d.unitPrice,
          netAmount: d.netAmount,
          vatRate: d.vatRate,
          vatAmount: d.vatAmount,
        })),
      };
    });
  }
}
