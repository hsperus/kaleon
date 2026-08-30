/**
 * MRP veri toplayıcısı.
 *
 * MOTOR SAF, VERİ TOPLAMA BURADA. Ayrım önemli: MRP hesabı ürünün en
 * karmaşık mantığıdır ve tek başına test edilebilmelidir. Veritabanına
 * bağlı olsaydı her senaryo için şema kurmak gerekir, kimse yeterince
 * senaryo yazmazdı.
 *
 * TÜM PLANLAMA VERİSİ TEK SEFERDE OKUNUR. Malzeme başına sorgu atılsaydı,
 * 400 kalemlik bir ürün ağacında binlerce gidiş-dönüş olur ve MRP
 * dakikalarca sürerdi — oysa MRP haftada bir değil, gün içinde defalarca
 * çalıştırılabilmelidir.
 */

import type { TenantDb } from "./client.js";
import {
  runMrp,
  type Demand,
  type ItemPlanningData,
  type MrpResult,
  type ScheduledReceipt,
} from "../modules/planning/mrp.js";

export class MrpRepository {
  readonly #db: TenantDb;

  constructor(db: TenantDb) {
    this.#db = db;
  }

  /**
   * Planlama verisini toplar: malzemeler, aktif ürün ağaçları, bakiyeler.
   *
   * Yalnızca AKTİF revizyon kullanılır. Pasif revizyonlar da alınsaydı,
   * aynı mamul için iki farklı ağaç hesaba girer ve ihtiyaç iki katına
   * çıkardı.
   */
  async planningData(): Promise<Map<string, ItemPlanningData>> {
    const [items, boms, balances] = await Promise.all([
      this.#db.item.findMany({
        where: { isActive: true },
        select: {
          id: true,
          code: true,
          type: true,
          procurementType: true,
          leadTimeDays: true,
          safetyStock: true,
        },
        take: 5000,
      }),
      this.#db.bomRevision.findMany({
        where: { isActive: true },
        include: {
          lines: {
            orderBy: { lineNo: "asc" },
            include: { component: { select: { code: true } } },
          },
        },
        take: 5000,
      }),
      this.#db.itemCostState.findMany({ select: { itemId: true, quantityOnHand: true } }),
    ]);

    const onHand = new Map(balances.map((b) => [b.itemId, Number(b.quantityOnHand)]));
    const bomByItem = new Map(boms.map((b) => [b.itemId, b]));

    const out = new Map<string, ItemPlanningData>();
    for (const it of items) {
      // Ürün ağacı `item_id` alanıyla bağlanır; bazı kurulumlarda kod,
      // bazılarında kimlik tutulur — ikisini de dene.
      const bom = bomByItem.get(it.code) ?? bomByItem.get(it.id);
      out.set(it.code, {
        code: it.code,
        type: it.type,
        procurementType: it.procurementType,
        leadTimeDays: it.leadTimeDays,
        safetyStock: it.safetyStock === null ? null : Number(it.safetyStock),
        onHand: onHand.get(it.code) ?? 0,
        components: (bom?.lines ?? []).map((l) => ({
          componentCode: l.component.code,
          quantityPer: Number(l.quantity),
          scrapPercent: Number(l.scrapPercent),
        })),
      });
    }
    return out;
  }

  /**
   * Talep: açık satış siparişlerinin SEVK EDİLMEMİŞ kısmı.
   *
   * Sevk edilen miktar düşülmeseydi, kısmen teslim edilmiş bir sipariş
   * için ikinci kez üretim planlanırdı.
   */
  async demands(): Promise<readonly Demand[]> {
    const orders = await this.#db.salesOrder.findMany({
      where: { status: { in: ["open", "partially_delivered", "partially_invoiced"] } },
      include: { lines: { orderBy: { lineNo: "asc" } } },
      take: 2000,
    });

    const out: Demand[] = [];
    for (const o of orders) {
      for (const l of o.lines) {
        const remaining = Number(l.quantity) - Number(l.deliveredQty);
        if (remaining <= 0) continue;
        out.push({
          itemCode: l.itemId,
          quantity: remaining,
          neededBy: o.committedDate,
          source: o.orderNo,
        });
      }
    }
    return out;
  }

  /**
   * Arz: açık satın alma siparişlerinin TESLİM ALINMAMIŞ kısmı.
   *
   * Mal kabulü yapılmış kısım düşülmeseydi, gelmiş mal ikinci kez
   * "yolda" sayılır ve ihtiyaç olduğundan düşük çıkardı.
   */
  async scheduledReceipts(): Promise<readonly ScheduledReceipt[]> {
    const orders = await this.#db.purchaseOrder.findMany({
      where: { status: "open" },
      include: { lines: { orderBy: { lineNo: "asc" } } },
      take: 2000,
    });
    if (orders.length === 0) return [];

    const receipts = await this.#db.goodsReceipt.groupBy({
      by: ["poId", "poLineNo"],
      where: { poId: { in: orders.map((o) => o.id) } },
      _sum: { quantity: true },
    });
    const received = new Map(
      receipts.map((r) => [`${r.poId}/${r.poLineNo}`, Number(r._sum.quantity ?? 0)]),
    );

    const out: ScheduledReceipt[] = [];
    for (const o of orders) {
      for (const l of o.lines) {
        const open = Number(l.quantity) - (received.get(`${o.id}/${l.lineNo}`) ?? 0);
        if (open <= 0) continue;
        out.push({
          itemCode: l.itemId,
          quantity: open,
          expectedAt: o.orderedAt,
          source: o.id,
        });
      }
    }
    return out;
  }

  async run(today: Date): Promise<MrpResult & { demandCount: number; itemCount: number }> {
    const [items, demands, scheduled] = await Promise.all([
      this.planningData(),
      this.demands(),
      this.scheduledReceipts(),
    ]);

    const result = runMrp({ items, demands, scheduled, today });
    return { ...result, demandCount: demands.length, itemCount: items.size };
  }
}
