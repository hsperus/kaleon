/**
 * Çerçeve sözleşme, tedarikçi karnesi ve fiyat kaydı veri erişimi.
 *
 * TAVAN KULLANIMI ÇEKİLİŞLERDEN TOPLANIR, SÖZLEŞMEDEKİ BİR SAYAÇTAN
 * DEĞİL. Sayaç tutulsaydı iptal edilen bir çekiliş onu düşürmez ve
 * tavan sonsuza kadar dolu görünürdü — sözleşme kullanılamaz hâle
 * gelir, kimse sebebini bulamazdı.
 */

import { BusinessRuleError } from "../kernel/errors.js";
import type { TenantDb } from "./client.js";
import type { ContractUsage, DeliveryRecord, PriceChange } from "../modules/procurement/scorecard.js";

function kurusla(n: number): number {
  return Math.round(n * 100) / 100;
}

export class SupplierRepository {
  readonly #db: TenantDb;

  constructor(db: TenantDb) {
    this.#db = db;
  }

  async createContract(input: {
    documentNo: string;
    partnerId: string;
    itemId: string | null;
    description: string;
    validFrom: Date;
    validTo: Date;
    ceilingAmount: number | null;
    ceilingQuantity: number | null;
    unitPrice: number | null;
    currency: string;
    userId: string;
  }): Promise<{ documentNo: string }> {
    const cari = await this.#db.partner.findUnique({ where: { id: input.partnerId } });
    if (!cari) {
      throw new BusinessRuleError("Cari bulunamadı.", "partner_not_found");
    }
    if (!cari.isSupplier) {
      throw new BusinessRuleError(
        `${cari.legalName} tedarikçi olarak işaretli değil. Müşteri kartıyla ` +
          `satın alma sözleşmesi açmak, cari bakiyesini yanlış tarafa yazar.`,
        "partner_not_supplier",
      );
    }
    if (await this.#db.purchaseContract.findUnique({ where: { documentNo: input.documentNo } })) {
      throw new BusinessRuleError(
        `${input.documentNo} numaralı sözleşme zaten var.`,
        "contract_exists",
      );
    }

    const row = await this.#db.purchaseContract.create({
      data: {
        documentNo: input.documentNo,
        partnerId: input.partnerId,
        itemId: input.itemId,
        description: input.description,
        validFrom: input.validFrom,
        validTo: input.validTo,
        ceilingAmount: input.ceilingAmount,
        ceilingQuantity: input.ceilingQuantity,
        unitPrice: input.unitPrice,
        currency: input.currency,
        createdBy: input.userId,
      },
    });
    return { documentNo: row.documentNo };
  }

  /** Sözleşme ve kullanım durumu. */
  async contractUsage(documentNo: string): Promise<{
    contract: {
      documentNo: string;
      partnerId: string;
      partnerName: string;
      itemId: string | null;
      description: string;
      validFrom: string;
      validTo: string;
      unitPrice: number | null;
      currency: string;
      status: string;
    };
    usage: ContractUsage;
    releaseCount: number;
  } | null> {
    const c = await this.#db.purchaseContract.findUnique({
      where: { documentNo },
      include: { releases: true },
    });
    if (!c) return null;

    const cari = await this.#db.partner.findUnique({ where: { id: c.partnerId } });
    const tutar = kurusla(c.releases.reduce((s, r) => s + Number(r.amount), 0));
    const miktar = c.releases.reduce((s, r) => s + Number(r.quantity), 0);
    const tavanTutar = c.ceilingAmount === null ? null : Number(c.ceilingAmount);
    const tavanMiktar = c.ceilingQuantity === null ? null : Number(c.ceilingQuantity);

    return {
      contract: {
        documentNo: c.documentNo,
        partnerId: c.partnerId,
        partnerName: cari?.legalName ?? "(cari kartı bulunamadı)",
        itemId: c.itemId,
        description: c.description,
        validFrom: c.validFrom.toISOString().slice(0, 10),
        validTo: c.validTo.toISOString().slice(0, 10),
        unitPrice: c.unitPrice === null ? null : Number(c.unitPrice),
        currency: c.currency,
        status: c.status,
      },
      usage: {
        usedAmount: tutar,
        usedQuantity: miktar,
        ceilingAmount: tavanTutar,
        ceilingQuantity: tavanMiktar,
        remainingAmount: tavanTutar === null ? null : kurusla(tavanTutar - tutar),
        remainingQuantity: tavanMiktar === null ? null : tavanMiktar - miktar,
      },
      releaseCount: c.releases.length,
    };
  }

  async listContracts(partnerId: string | null, activeOnly: boolean) {
    const rows = await this.#db.purchaseContract.findMany({
      where: {
        ...(partnerId ? { partnerId } : {}),
        ...(activeOnly ? { status: "active" } : {}),
      },
      include: { releases: { select: { amount: true, quantity: true } } },
      orderBy: { validTo: "asc" },
      take: 100,
    });
    const cariler = new Map(
      (
        await this.#db.partner.findMany({
          where: { id: { in: [...new Set(rows.map((r) => r.partnerId))] } },
          select: { id: true, legalName: true },
        })
      ).map((p) => [p.id, p.legalName]),
    );
    return rows.map((c) => {
      const tutar = kurusla(c.releases.reduce((s, r) => s + Number(r.amount), 0));
      const tavan = c.ceilingAmount === null ? null : Number(c.ceilingAmount);
      return {
        documentNo: c.documentNo,
        partnerName: cariler.get(c.partnerId) ?? "(cari kartı bulunamadı)",
        itemId: c.itemId,
        description: c.description,
        validTo: c.validTo.toISOString().slice(0, 10),
        status: c.status,
        currency: c.currency,
        usedAmount: tutar,
        ceilingAmount: tavan,
        usedPercent: tavan === null || tavan === 0 ? null : Math.round((tutar / tavan) * 1000) / 10,
      };
    });
  }

  async recordRelease(input: {
    contractId: string;
    poId: string;
    quantity: number;
    amount: number;
    releasedAt: Date;
    userId: string;
  }): Promise<void> {
    const varMi = await this.#db.contractRelease.findUnique({
      where: { contractId_poId: { contractId: input.contractId, poId: input.poId } },
    });
    if (varMi) {
      throw new BusinessRuleError(
        `${input.poId} siparişi bu sözleşmeden zaten çekilmiş. Aynı siparişi iki ` +
          `kez çekmek tavanı iki kat tüketir.`,
        "release_exists",
      );
    }
    await this.#db.contractRelease.create({
      data: {
        contractId: input.contractId,
        poId: input.poId,
        quantity: input.quantity,
        amount: input.amount,
        releasedAt: input.releasedAt,
        releasedBy: input.userId,
      },
    });
  }

  async contractIdOf(documentNo: string): Promise<string | null> {
    const c = await this.#db.purchaseContract.findUnique({
      where: { documentNo },
      select: { id: true },
    });
    return c?.id ?? null;
  }

  /**
   * Bir tedarikçinin teslimat geçmişi — karnenin ham maddesi.
   *
   * Mal kabul kayıtları sipariş satırıyla eşleştirilerek termin ve
   * miktar performansı çıkarılır. Ayrı bir "performans" tablosu
   * tutulmuyor: tutulsaydı geriye dönük bir düzeltme onu güncellemez
   * ve karne defterden ayrışırdı.
   */
  async deliveryHistory(partnerId: string, since: Date): Promise<readonly DeliveryRecord[]> {
    const siparisler = await this.#db.purchaseOrder.findMany({
      where: { partnerId, orderedAt: { gte: since } },
      include: { lines: true },
      take: 500,
    });
    if (siparisler.length === 0) return [];

    const kabuller = await this.#db.goodsReceipt.findMany({
      where: { poId: { in: siparisler.map((s) => s.id) } },
    });

    const kayitlar: DeliveryRecord[] = [];
    for (const s of siparisler) {
      for (const l of s.lines) {
        const satirKabulleri = kabuller.filter((k) => k.poId === s.id && k.poLineNo === l.lineNo);
        if (satirKabulleri.length === 0) continue; // henüz gelmedi
        const toplam = satirKabulleri.reduce((t, k) => t + Number(k.quantity), 0);
        // Son kabul tarihi: sipariş tamamlandığında gelmiş sayılır.
        const sonKabul = satirKabulleri.reduce(
          (a, b) => (b.receivedAt > a.receivedAt ? b : a),
          satirKabulleri[0]!,
        );
        kayitlar.push({
          poId: s.id,
          itemId: l.itemId,
          promisedDate: l.promisedDate,
          receivedAt: sonKabul.receivedAt,
          orderedQuantity: Number(l.quantity),
          receivedQuantity: toplam,
        });
      }
    }
    return kayitlar;
  }

  /** Fiyat değişimi — aynı malzemede önceki ve son fiyat. */
  async priceChanges(partnerId: string): Promise<readonly PriceChange[]> {
    const kayitlar = await this.#db.purchaseInfoRecord.findMany({ where: { partnerId } });
    if (kayitlar.length === 0) return [];

    const degisimler: PriceChange[] = [];
    for (const k of kayitlar) {
      // Aynı malzemenin bu tedarikçideki önceki sipariş fiyatı.
      const oncekiler = await this.#db.purchaseOrderLine.findMany({
        where: { itemId: k.itemId, purchaseOrder: { partnerId } },
        orderBy: { purchaseOrder: { orderedAt: "desc" } },
        select: { unitPrice: true },
        take: 2,
      });
      if (oncekiler.length < 2) continue;
      degisimler.push({
        itemId: k.itemId,
        previousPrice: Number(oncekiler[1]!.unitPrice),
        currentPrice: Number(oncekiler[0]!.unitPrice),
      });
    }
    return degisimler;
  }

  async partnerName(partnerId: string): Promise<string | null> {
    const p = await this.#db.partner.findUnique({
      where: { id: partnerId },
      select: { legalName: true },
    });
    return p?.legalName ?? null;
  }

  /** Bir malzemenin tedarikçi bazında fiyat geçmişi. */
  async priceHistory(itemId: string) {
    const satirlar = await this.#db.purchaseOrderLine.findMany({
      where: { itemId },
      include: { purchaseOrder: { select: { partnerId: true, orderedAt: true } } },
      orderBy: { purchaseOrder: { orderedAt: "desc" } },
      take: 100,
    });
    const cariler = new Map(
      (
        await this.#db.partner.findMany({
          where: { id: { in: [...new Set(satirlar.map((s) => s.purchaseOrder.partnerId))] } },
          select: { id: true, legalName: true },
        })
      ).map((p) => [p.id, p.legalName]),
    );
    return satirlar.map((s) => ({
      partnerName: cariler.get(s.purchaseOrder.partnerId) ?? "(cari kartı bulunamadı)",
      orderedAt: s.purchaseOrder.orderedAt.toISOString().slice(0, 10),
      unitPrice: Number(s.unitPrice),
      currency: s.currency,
      quantity: Number(s.quantity),
    }));
  }
}
