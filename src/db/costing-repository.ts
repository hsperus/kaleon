/**
 * İş emri maliyeti — gerçek hareketlerden.
 *
 * MALİYET HESAPLANMAZ, TOPLANIR. İş emrine sarf edilen her malzeme
 * hareketi kendi değerini zaten taşıyor (değerleme sırasında donduruldu);
 * burada yapılan şey onları iş emri altında toplamaktır. Yeniden
 * hesaplansaydı, bugünkü ortalamayla geçmiş bir sarfiyat değerlenir ve
 * tamamlanmış bir iş emrinin maliyeti her gün değişirdi.
 */

import type { TenantDb } from "./client.js";
import {
  accumulate,
  variance,
  varianceByElement,
  type CostBreakdown,
  type LaborEntry,
  type MaterialConsumption,
  type Variance,
} from "../modules/operations/order-costing.js";

export interface OrderCostReport {
  readonly workOrderId: string;
  readonly itemCode: string;
  readonly plannedQuantity: number;
  readonly producedQuantity: number;
  readonly actual: CostBreakdown;
  readonly variance: Variance;
  readonly byElement: ReturnType<typeof varianceByElement>;
}

export class CostingRepository {
  readonly #db: TenantDb;
  /**
   * İşçilik ve GÜG oranı ayarları.
   *
   * Şimdilik iş merkezi kartında saatlik ücret alanı yok; tanımsız
   * kabul ediliyor ve bu AÇIKÇA raporlanıyor. Sıfır varsaymak, ürünü
   * olduğundan ucuz göstermek olurdu.
   */
  readonly #hourlyRates: ReadonlyMap<string, number>;
  readonly #overheadPercent: number | null;

  constructor(
    db: TenantDb,
    options: {
      hourlyRates?: ReadonlyMap<string, number>;
      overheadPercent?: number | null;
    } = {},
  ) {
    this.#db = db;
    this.#hourlyRates = options.hourlyRates ?? new Map();
    this.#overheadPercent = options.overheadPercent ?? null;
  }

  /**
   * İş emrine sarf edilen malzemeler.
   *
   * Yalnızca 261 (iş emrine sarf) ve `reference_kind = work_order`
   * hareketleri sayılır. Tüm çıkışlar sayılsaydı, aynı depodan yapılan
   * bir sevkiyat da üretim maliyetine girerdi.
   */
  async consumption(workOrderId: string): Promise<readonly MaterialConsumption[]> {
    const rows = await this.#db.stockMovement.findMany({
      where: {
        referenceKind: "work_order",
        referenceId: workOrderId,
        direction: -1,
      },
      select: { itemId: true, quantity: true, value: true },
      take: 2000,
    });
    return rows.map((r) => ({
      itemCode: r.itemId,
      quantity: Number(r.quantity),
      value: r.value === null ? null : Number(r.value),
    }));
  }

  /**
   * Operasyonlarda harcanan süre.
   *
   * Süre kaydı henüz operasyon başına tutulmuyor; onaylanan miktar ve iş
   * merkezinin hedef hızı üzerinden TÜRETİLİR. Türetildiği açıkça
   * söylenir: ölçülen süre ile türetilen süre farklı güvenilirlikte
   * bilgilerdir.
   */
  async labor(workOrderId: string): Promise<{ entries: readonly LaborEntry[]; derived: boolean }> {
    const ops = await this.#db.workOrderOperation.findMany({
      where: { workOrderId, confirmedQty: { gt: 0 } },
      select: { workCenter: true, confirmedQty: true },
    });
    if (ops.length === 0) return { entries: [], derived: false };

    const centers = await this.#db.workCenter.findMany({
      where: { code: { in: ops.map((o) => o.workCenter) } },
      select: { code: true, targetRatePerHour: true },
    });
    const rateOf = new Map(
      centers.map((c) => [c.code, c.targetRatePerHour === null ? null : Number(c.targetRatePerHour)]),
    );

    const entries: LaborEntry[] = [];
    for (const op of ops) {
      const target = rateOf.get(op.workCenter) ?? null;
      // Hedef hız tanımsızsa süre türetilemez; sıfır saat yazmak işçiliği
      // yok saymak olurdu.
      const hours = target && target > 0 ? Number(op.confirmedQty) / target : 0;
      entries.push({
        workCenter: op.workCenter,
        hours,
        hourlyRate: this.#hourlyRates.get(op.workCenter) ?? null,
      });
    }
    return { entries, derived: true };
  }

  /** Standart birim maliyet — malzeme kartından. */
  async standardCost(itemCode: string): Promise<number | null> {
    const item = await this.#db.item.findUnique({
      where: { code: itemCode },
      select: { standardCost: true, valuationMethod: true },
    });
    if (!item || item.standardCost === null) return null;
    return Number(item.standardCost);
  }

  async report(workOrderId: string): Promise<OrderCostReport | null> {
    const wo = await this.#db.workOrder.findUnique({
      where: { id: workOrderId },
      include: { operations: { orderBy: { seq: "asc" } } },
    });
    if (!wo) return null;

    const [materials, laborData, standard] = await Promise.all([
      this.consumption(workOrderId),
      this.labor(workOrderId),
      this.standardCost(wo.itemId),
    ]);

    const actual = accumulate({
      materials,
      labor: laborData.entries,
      overhead: { rateOnLaborPercent: this.#overheadPercent },
    });

    if (laborData.derived && laborData.entries.some((e) => e.hours > 0)) {
      // TÜRETİLMİŞ SÜRE ÖLÇÜLMÜŞ SÜRE DEĞİLDİR ve bu söylenir.
      (actual.unknowns as string[]).push(
        "İşçilik süresi ölçülmedi; onaylanan miktar ve hedef hızdan TÜRETİLDİ.",
      );
    }

    // Üretilen miktar: son operasyonun onayı. Yoksa sıfır — plan miktarı
    // DEĞİL: planlanan üretilmiş sayılırsa maliyet olduğundan düşük çıkar.
    const lastOp = wo.operations.at(-1);
    const produced = lastOp ? Number(lastOp.confirmedQty) : 0;

    return {
      workOrderId,
      itemCode: wo.itemId,
      plannedQuantity: Number(wo.quantity),
      producedQuantity: produced,
      actual,
      variance: variance({
        quantityProduced: produced,
        actual,
        standardUnitCost: standard,
      }),
      // STANDART KIRILIMI YOK. Malzeme kartında tek bir standart birim
      // maliyet var; bunun ne kadarının malzeme, ne kadarının işçilik
      // olduğu tanımlı değil. Tamamını malzemeye yazmak, OLMAYAN bir
      // işçilik sapması uydurur ve yanlış yere baktırır. Kırılım
      // bilinmiyorsa null geçilir ve yalnızca fiili tutarlar gösterilir.
      byElement: varianceByElement(actual, null),
    };
  }
}
