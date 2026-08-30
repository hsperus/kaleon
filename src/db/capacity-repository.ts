/**
 * Kapasite verisi toplayıcısı.
 *
 * MRP'NİN ÜRETTİĞİ PLAN, KAPASİTEYE KARŞI KONTROL EDİLMEDEN TAAHHÜT
 * SAYILMAZ. Malzeme zamanında gelse bile kaynak makinesi doluysa iş
 * yetişmez; sonsuz kapasite varsayımı planlamanın en yaygın yalanıdır.
 */

import type { TenantDb } from "./client.js";
import {
  loadProfile,
  requiredHours,
  type CapacityDemand,
  type CapacityResult,
  type WorkCenterCapacity,
} from "../modules/planning/capacity.js";

/** Günlük çalışma süresi varsayımı — iş merkezinde tanımlı değilse. */
export const DEFAULT_SHIFT_HOURS = 8;

export class CapacityRepository {
  readonly #db: TenantDb;

  constructor(db: TenantDb) {
    this.#db = db;
  }

  async centers(): Promise<readonly WorkCenterCapacity[]> {
    const rows = await this.#db.workCenter.findMany({
      where: { isActive: true },
      take: 500,
    });
    return rows.map((c) => ({
      code: c.code,
      name: c.name,
      // Günlük kapasite = eşzamanlı iş sayısı × vardiya süresi.
      // Eşzamanlı kapasite tanımsızsa günlük saat de HESAPLANMAZ:
      // varsayılan bir sayı uydurmak, planı hayalî yapar.
      dailyHours:
        c.concurrentCapacity === null ? null : c.concurrentCapacity * DEFAULT_SHIFT_HOURS,
      concurrent: c.concurrentCapacity,
    }));
  }

  /**
   * Açık iş emirlerinin kapasite talebi.
   *
   * Süre, iş merkezinin HEDEF HIZINDAN türetilir; hedef hız tanımsızsa
   * o operasyon plana girmez ve bu söylenir — varsayılan bir hız
   * uydurmak, sıkışıklığı olduğundan az gösterir.
   */
  async demands(): Promise<{ demands: readonly CapacityDemand[]; skipped: readonly string[] }> {
    const orders = await this.#db.workOrder.findMany({
      where: { status: { in: ["released", "in_progress", "created"] } },
      include: { operations: { orderBy: { seq: "asc" } } },
      take: 2000,
    });

    const centers = await this.#db.workCenter.findMany({
      select: { code: true, targetRatePerHour: true },
    });
    const rateOf = new Map(
      centers.map((c) => [c.code, c.targetRatePerHour === null ? null : Number(c.targetRatePerHour)]),
    );

    const demands: CapacityDemand[] = [];
    const skipped: string[] = [];

    for (const wo of orders) {
      // Planlanan bitiş yoksa yük hangi güne yazılacağı bilinmez.
      if (!wo.plannedEndDate) {
        skipped.push(`${wo.id}: planlanan bitiş tarihi yok, yük tarihe yazılamadı`);
        continue;
      }

      for (const op of wo.operations) {
        if (op.state === "confirmed" || op.state === "skipped") continue;
        const remaining = Number(wo.quantity) - Number(op.confirmedQty);
        if (remaining <= 0) continue;

        const hours = requiredHours(remaining, rateOf.get(op.workCenter) ?? null);
        if (hours === null) {
          skipped.push(
            `${wo.id}/${op.seq}: "${op.workCenter}" hedef hızı tanımsız, süre hesaplanamadı`,
          );
          continue;
        }

        demands.push({
          workCenter: op.workCenter,
          hours,
          dueDate: wo.plannedEndDate,
          source: `${wo.id}/${op.seq}`,
        });
      }
    }

    return { demands, skipped };
  }

  async load(): Promise<CapacityResult & { skipped: readonly string[] }> {
    const [centers, { demands, skipped }] = await Promise.all([this.centers(), this.demands()]);
    const result = loadProfile({ centers, demands });
    return { ...result, skipped };
  }
}
