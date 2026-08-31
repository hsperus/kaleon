/**
 * Kredi riski ve stok taahhüdü veri erişimi.
 *
 * AYRILMIŞ MİKTAR SİPARİŞ SATIRLARINDAN HESAPLANIR, AYRI BİR
 * "REZERVASYON" TABLOSUNDAN DEĞİL.
 *
 * Rezervasyon tablosu tutmak daha hızlı olurdu ve zamanla siparişten
 * ayrışırdı: bir sipariş iptal edilir, rezervasyon kalır ve stok
 * sonsuza kadar "ayrılmış" görünür. Kaynak sipariş satırının kendisi:
 * sipariş miktarı eksi sevk edilen miktar.
 */

import type { TenantDb } from "./client.js";
import type { StockPosition } from "../modules/sales/availability.js";

function kurusla(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface PartnerCredit {
  readonly partnerId: string;
  readonly partnerName: string;
  readonly limit: number | null;
  readonly currency: string;
  readonly blocked: boolean;
  readonly blockReason: string | null;
  readonly overdue: number;
  readonly openInvoices: number;
  readonly openOrders: number;
}

export class CreditRepository {
  readonly #db: TenantDb;

  constructor(db: TenantDb) {
    this.#db = db;
  }

  /** Bir carinin risk bileşenleri. */
  async exposureFor(partnerId: string, asOf: Date): Promise<PartnerCredit | null> {
    const p = await this.#db.partner.findUnique({ where: { id: partnerId } });
    if (!p) return null;

    const faturalar = await this.#db.salesInvoice.findMany({
      where: { partnerId, status: "issued", cancelledAt: null },
      select: { documentNo: true, totalAmount: true, dueDate: true },
    });

    const odenen = new Map(
      (
        await this.#db.paymentAllocation.groupBy({
          by: ["invoiceNo"],
          _sum: { amount: true },
          where: { invoiceNo: { in: faturalar.map((f) => f.documentNo) } },
        })
      ).map((a) => [a.invoiceNo, Number(a._sum.amount ?? 0)]),
    );

    let gecikmis = 0;
    let acik = 0;
    for (const f of faturalar) {
      const kalan = kurusla(Number(f.totalAmount) - (odenen.get(f.documentNo) ?? 0));
      if (kalan <= 0.005) continue;
      /*
       * VADESİ BİLİNMEYEN FATURA "GECİKMİŞ" SAYILMAZ.
       *
       * Sayılsaydı, vade girilmemiş her fatura riski en ağır kategoriye
       * atar ve kredi kontrolünü sürekli yanlış tetiklerdi.
       */
      if (f.dueDate !== null && f.dueDate < asOf) gecikmis = kurusla(gecikmis + kalan);
      else acik = kurusla(acik + kalan);
    }

    // Sevk edilmemiş sipariş bakiyesi — henüz fatura yok ama taahhüt var.
    const satirlar = await this.#db.salesOrderLine.findMany({
      where: { salesOrder: { partnerId, status: { notIn: ["cancelled", "closed"] } } },
      select: { quantity: true, deliveredQty: true, unitPrice: true, discountPercent: true },
    });
    const acikSiparis = satirlar.reduce((s, l) => {
      const kalanMiktar = Number(l.quantity) - Number(l.deliveredQty);
      if (kalanMiktar <= 0) return s;
      const birim = Number(l.unitPrice) * (1 - Number(l.discountPercent) / 100);
      return s + kalanMiktar * birim;
    }, 0);

    return {
      partnerId: p.id,
      partnerName: p.legalName,
      limit: p.creditLimit === null ? null : Number(p.creditLimit),
      currency: p.creditCurrency,
      blocked: p.creditBlocked,
      blockReason: p.creditBlockReason,
      overdue: gecikmis,
      openInvoices: acik,
      openOrders: kurusla(acikSiparis),
    };
  }

  async setLimit(input: {
    partnerId: string;
    limit: number | null;
    currency: string;
    blocked: boolean;
    blockReason: string | null;
    userId: string;
  }): Promise<{ partnerName: string; previousLimit: number | null }> {
    const p = await this.#db.partner.findUnique({ where: { id: input.partnerId } });
    if (!p) {
      throw new Error(`Cari bulunamadı: ${input.partnerId}`);
    }
    const { setChangeActor } = await import("./change-log.js");
    await this.#db.$transaction(async (tx) => {
      // Değişiklik izi tetikleyicisi aktörü buradan okuyor: limiti kim
      // yükseltti sorusu, limitin kendisinden daha önemlidir.
      await setChangeActor(tx, input.userId);
      await tx.partner.update({
        where: { id: input.partnerId },
        data: {
          creditLimit: input.limit,
          creditCurrency: input.currency,
          creditBlocked: input.blocked,
          creditBlockReason: input.blockReason,
        },
      });
    });
    return {
      partnerName: p.legalName,
      previousLimit: p.creditLimit === null ? null : Number(p.creditLimit),
    };
  }

  /**
   * Bir malzemenin stok pozisyonu.
   *
   * ELDEKİ: bütün lokasyonların toplamı.
   * AYRILMIŞ: açık sipariş satırlarının sevk edilmemiş kısmı.
   * YOLDAKİ: açık satın alma siparişlerinin bekleyen kısmı.
   */
  async stockPosition(itemCode: string): Promise<StockPosition | null> {
    const item = await this.#db.item.findUnique({ where: { code: itemCode } });
    if (!item) return null;

    const hareket = await this.#db.stockMovement.aggregate({
      where: { itemId: itemCode },
      _sum: { quantity: true },
    });

    const satisSatirlari = await this.#db.salesOrderLine.findMany({
      where: { itemId: itemCode, salesOrder: { status: { notIn: ["cancelled", "closed"] } } },
      select: { quantity: true, deliveredQty: true },
    });
    const ayrilmis = satisSatirlari.reduce(
      (s, l) => s + Math.max(0, Number(l.quantity) - Number(l.deliveredQty)),
      0,
    );

    /*
     * YOLDAKİ MAL: sipariş miktarı eksi TESLİM ALINAN.
     *
     * Teslim alınan miktar sipariş satırında tutulmuyor, mal kabul
     * kayıtlarından toplanıyor — ve doğrusu bu: satırdaki bir sayaç
     * ile mal kabul kayıtları zamanla ayrışır ve hangisinin doğru
     * olduğu belirsizleşir.
     *
     * TERMİNİ OLMAYAN SATIR HESABA KATILMAZ. Tarihsiz bir bekleyen
     * mal, teslim taahhüdüne giremez.
     */
    const alimSatirlari = await this.#db.purchaseOrderLine.findMany({
      where: { itemId: itemCode, promisedDate: { not: null } },
      select: {
        poId: true,
        lineNo: true,
        quantity: true,
        promisedDate: true,
        purchaseOrder: { select: { status: true } },
      },
      take: 200,
    });

    const kabuller = await this.#db.goodsReceipt.groupBy({
      by: ["poId", "poLineNo"],
      _sum: { quantity: true },
      where: { poId: { in: [...new Set(alimSatirlari.map((l) => l.poId))] } },
    });
    const alinan = new Map(
      kabuller.map((k) => [`${k.poId}|${k.poLineNo}`, Number(k._sum.quantity ?? 0)]),
    );

    const yolda = alimSatirlari
      .filter((l) => l.purchaseOrder.status !== "cancelled")
      .map((l) => ({
        date: l.promisedDate!,
        quantity: Number(l.quantity) - (alinan.get(`${l.poId}|${l.lineNo}`) ?? 0),
      }))
      .filter((y) => y.quantity > 0);

    return {
      itemCode,
      onHand: Number(hareket._sum.quantity ?? 0),
      committed: ayrilmis,
      inbound: yolda,
      leadTimeDays: item.leadTimeDays,
    };
  }
}
