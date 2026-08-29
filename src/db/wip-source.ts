/**
 * Fabrika anlık durumu (WIP) — Postgres adaptörü.
 *
 * BU DOSYANIN TEK KURALI: BİLİNMEYEN SAYI UYDURULMAZ.
 *
 * "0 makine çalışıyor" ile "makine kaydı yok" aynı ekranda aynı görünürse,
 * ya fabrika durmuş sanılır ya da gerçek duruş fark edilmez. İkisi de pahalı.
 * Bilinmeyen alanlar `null` döner ve nedeni `caveats` ile cevaba taşınır.
 *
 * NE TÜRETİLİR, NE TÜRETİLMEZ:
 *
 *   activeWorkOrders  → türetilir (iş emri sayımı)
 *   stations          → türetilir (operasyon durumları)
 *   utilizationPct    → iş merkezinin eşzamanlı kapasitesi tanımlıysa
 *   machinesRunning   → en güncel makine durumu anlık görüntüsünden
 *   targetRatePerHour → iş merkezi tanımından (aktif olanların toplamı)
 *   staffOnShift      → BİLİNMİYOR: vardiya/canlı yoklama beslemesi yok
 *   actualRatePerHour → BİLİNMİYOR: üretim onayları zaman damgalı tutulmuyor
 *
 * Son iki alan bilinçli olarak null. İkisi de canlı bir saha beslemesi
 * gerektirir; olmayan bir beslemeye karşı kod yazmak, test edilemeyen ve
 * ilk gerçek kurulumda yanlış çıkan kod yazmaktır (BUILD-PLAN değişmez #9).
 */

import type { StationLoad, WipSnapshot, WithFreshness } from "../data/port.js";
import type { TenantDb } from "./client.js";

/** İş emri operasyonunun "şu an tezgâhta" sayıldığı durumlar. */
const ACTIVE_OPERATION_STATES = ["in_progress", "ready"];
/** Kalite kapısı veya başka bir sebeple bekleyen. */
const HOLD_OPERATION_STATES = ["blocked", "awaiting_gate"];

const ACTIVE_WORK_ORDER_STATES = ["released", "in_progress"];

export class PrismaWipSource {
  readonly #db: TenantDb;

  constructor(db: TenantDb) {
    this.#db = db;
  }

  async wipSnapshot(): Promise<WithFreshness<WipSnapshot>> {
    const caveats: string[] = [];

    const [activeWorkOrders, operations, workCenters, machines] = await Promise.all([
      this.#db.workOrder.count({ where: { status: { in: ACTIVE_WORK_ORDER_STATES } } }),
      this.#db.workOrderOperation.findMany({
        where: {
          state: { in: [...ACTIVE_OPERATION_STATES, ...HOLD_OPERATION_STATES] },
          workOrder: { status: { in: ACTIVE_WORK_ORDER_STATES } },
        },
        select: { workCenter: true, state: true },
      }),
      this.#db.workCenter.findMany({ where: { isActive: true } }),
      this.#db.machine.findMany({
        where: { isActive: true },
        include: { statuses: { orderBy: { asOf: "desc" }, take: 1 } },
      }),
    ]);

    // ── İstasyon yükü
    const centerByCode = new Map(workCenters.map((c) => [c.code, c]));
    const load = new Map<string, { active: number; hold: number }>();

    for (const op of operations) {
      const cur = load.get(op.workCenter) ?? { active: 0, hold: 0 };
      if (HOLD_OPERATION_STATES.includes(op.state)) cur.hold += 1;
      else cur.active += 1;
      load.set(op.workCenter, cur);
    }
    // Yükü olmayan iş merkezleri de görünür — boş bir tezgâh da bilgidir.
    for (const c of workCenters) if (!load.has(c.code)) load.set(c.code, { active: 0, hold: 0 });

    const uncapacitated: string[] = [];
    const stations: StationLoad[] = [...load.entries()]
      .map(([station, l]): StationLoad => {
        const center = centerByCode.get(station);
        const capacity = center?.concurrentCapacity ?? null;
        if (capacity === null) uncapacitated.push(station);
        return {
          station,
          utilizationPct:
            capacity === null || capacity === 0
              ? null
              : Math.round((l.active / capacity) * 100),
          activeOrders: l.active,
          holdOrders: l.hold,
          note:
            l.hold > 0
              ? `${l.hold} operasyon kalite kapısı veya duruş nedeniyle bekliyor.`
              : `${l.active} operasyon işlemde.`,
        };
      })
      .sort((a, b) => b.activeOrders - a.activeOrders);

    if (uncapacitated.length > 0) {
      caveats.push(
        `${uncapacitated.length} iş merkezinin kapasitesi tanımlı değil, doluluk oranı hesaplanamadı: ${uncapacitated.join(", ")}.`,
      );
    }

    // ── Makineler
    let machinesTotal: number | null = machines.length;
    let machinesRunning: number | null = null;
    let machineAsOf: Date | null = null;

    if (machines.length === 0) {
      // Kayıt yoksa "0 makine var" denmez — makine modülü kurulmamış olabilir.
      machinesTotal = null;
      caveats.push("Makine kaydı yok; makine durumu bilinmiyor.");
    } else {
      const withStatus = machines.filter((m) => m.statuses.length > 0);
      if (withStatus.length === 0) {
        caveats.push(
          `${machines.length} makine kayıtlı ama hiçbirinden durum bilgisi gelmemiş; çalışan makine sayısı bilinmiyor.`,
        );
      } else {
        machinesRunning = withStatus.filter((m) => m.statuses[0]!.state === "running").length;
        for (const m of withStatus) {
          const at = m.statuses[0]!.asOf;
          if (!machineAsOf || at < machineAsOf) machineAsOf = at;
        }
        if (withStatus.length < machines.length) {
          caveats.push(
            `${machines.length - withStatus.length} makineden durum bilgisi gelmiyor; çalışan sayısı eksik olabilir.`,
          );
        }
      }
    }

    // ── Hedef hız: tanımlı iş merkezlerinin toplamı
    const targets = workCenters
      .map((c) => c.targetRatePerHour)
      .filter((v): v is NonNullable<typeof v> => v !== null);
    const targetRatePerHour =
      targets.length === 0 ? null : targets.reduce((s, v) => s + Number(v), 0);
    if (targetRatePerHour === null && workCenters.length > 0) {
      caveats.push("Hiçbir iş merkezinde hedef hız tanımlı değil.");
    }

    // ── Bilinçli olarak bağlanmamış kanallar
    caveats.push(
      "Vardiya/yoklama beslemesi bağlı değil; vardiyadaki personel sayısı bilinmiyor.",
      "Üretim onayları zaman damgalı tutulmadığı için gerçek üretim hızı hesaplanamıyor.",
    );

    return {
      rows: {
        activeWorkOrders,
        staffOnShift: null,
        staffPlanned: null,
        machinesRunning,
        machinesTotal,
        stations,
        actualRatePerHour: null,
        targetRatePerHour,
      },
      freshness: {
        syncedAt: (machineAsOf ?? new Date()).toISOString(),
        recordCount: stations.length,
      },
      caveats,
    };
  }
}
