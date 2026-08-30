/**
 * Bakım yönetimi (PM/EAM).
 *
 * BİR İMALAT KOBİ'SİNDE DURAN TEZGÂH, EKSİK MALZEMEDEN PAHALIDIR.
 * Malzeme gecikirse sipariş kayar; tezgâh arızalanırsa o gün üretilecek
 * her şey kayar ve tamir süresi tahmin edilemez. Buna rağmen bakım,
 * çoğu KOBİ'de bir defterde ya da ustabaşının aklında durur.
 *
 * İKİ TÜR BAKIM, İKİ FARKLI EKONOMİ:
 *   PLANLI    — takvime veya sayaca bağlı, maliyeti önceden bilinir
 *   ARIZA     — plansız, maliyeti duruş süresiyle çarpılır
 * Planlı bakımın amacı arızayı önlemektir; oranı ölçülmezse "bakım
 * yapıyoruz" denir ama arıza azalmaz.
 *
 * SAYAÇ BAZLI BAKIM TARİHTEN DAHA DOĞRUDUR. "Her 3 ayda bir" diyen bir
 * plan, az çalışan tezgâhı gereksiz durdurur, çok çalışanı geç yakalar.
 * Çalışma saati bilinmiyorsa takvim kullanılır ve bu SÖYLENİR.
 */

export const MAINTENANCE_KINDS = ["planli", "ariza", "kestirimci"] as const;
export type MaintenanceKind = (typeof MAINTENANCE_KINDS)[number];

export const MAINTENANCE_STATUSES = [
  "planned",
  "released",
  "in_progress",
  "completed",
  "cancelled",
] as const;
export type MaintenanceStatus = (typeof MAINTENANCE_STATUSES)[number];

/** Arızanın üretime etkisi — önceliği bu belirler, "acil" etiketi değil. */
export const BREAKDOWN_SEVERITIES = ["durdurdu", "yavaslatti", "etkilemedi"] as const;
export type BreakdownSeverity = (typeof BREAKDOWN_SEVERITIES)[number];

export class MaintenanceError extends Error {
  readonly code = "maintenance";
  constructor(message: string) {
    super(message);
    this.name = "MaintenanceError";
  }
}

export interface MaintenancePlan {
  readonly machineCode: string;
  readonly description: string;
  /** Takvim aralığı (gün). Sayaç varsa ikincildir. */
  readonly intervalDays: number | null;
  /** Sayaç aralığı (çalışma saati). BİLİNMİYORSA null. */
  readonly intervalHours: number | null;
  readonly lastDoneAt: Date | null;
  /** Son bakımdaki sayaç değeri. */
  readonly lastDoneHours: number | null;
  /** Makinenin GÜNCEL çalışma saati. Bilinmiyorsa null. */
  readonly currentHours: number | null;
}

export interface DueResult {
  readonly due: boolean;
  readonly dueDate: string | null;
  readonly overdueDays: number;
  /** Sayaca göre kalan/aşan saat. */
  readonly hoursRemaining: number | null;
  readonly basis: "sayac" | "takvim" | "bilinmiyor";
  readonly explanation: string;
}

const DAY_MS = 86_400_000;

/**
 * Bakım zamanı geldi mi.
 *
 * SAYAÇ ÖNCE BAKILIR. Takvim, sayacın bilinmediği durumda devreye girer
 * ve bu açıkça söylenir — "3 ayda bir" kuralı az çalışan tezgâhı
 * gereksiz durdurur, çok çalışanı geç yakalar.
 */
export function isDue(plan: MaintenancePlan, on: Date): DueResult {
  // Sayaç yolu
  if (plan.intervalHours !== null && plan.currentHours !== null) {
    const since = plan.currentHours - (plan.lastDoneHours ?? 0);
    const remaining = Math.round((plan.intervalHours - since) * 10) / 10;
    return {
      due: remaining <= 0,
      dueDate: null,
      overdueDays: 0,
      hoursRemaining: remaining,
      basis: "sayac",
      explanation:
        remaining <= 0
          ? `Sayaca göre bakım zamanı ${Math.abs(remaining)} saat GEÇTİ ` +
            `(son bakımdan bu yana ${Math.round(since)} saat çalıştı).`
          : `Sayaca göre bakıma ${remaining} saat var.`,
    };
  }

  // Takvim yolu
  if (plan.intervalDays !== null && plan.lastDoneAt !== null) {
    const dueAt = new Date(plan.lastDoneAt.getTime() + plan.intervalDays * DAY_MS);
    const overdue = Math.max(0, Math.floor((on.getTime() - dueAt.getTime()) / DAY_MS));
    return {
      due: on >= dueAt,
      dueDate: dueAt.toISOString().slice(0, 10),
      overdueDays: overdue,
      hoursRemaining: null,
      basis: "takvim",
      explanation:
        overdue > 0
          ? `Takvime göre bakım ${overdue} gün GECİKTİ (planlanan ${dueAt
              .toISOString()
              .slice(0, 10)}). Makinenin çalışma saati bilinmediği için takvim ` +
            `kullanıldı; sayaç bilinseydi tarih farklı çıkabilirdi.`
          : `Takvime göre bakım tarihi ${dueAt.toISOString().slice(0, 10)}.`,
    };
  }

  // HİÇBİR ÖLÇÜ YOKSA "ZAMANI GELMEDİ" DENMEZ.
  return {
    due: false,
    dueDate: null,
    overdueDays: 0,
    hoursRemaining: null,
    basis: "bilinmiyor",
    explanation:
      plan.lastDoneAt === null
        ? "Bu makineye hiç bakım yapılmamış ve aralık tanımlı değil; bakım zamanı " +
          "HESAPLANAMIYOR. 'Zamanı gelmedi' DEĞİL, 'bilinmiyor'."
        : "Bakım aralığı tanımlı değil; zamanı hesaplanamıyor.",
  };
}

export interface BreakdownInput {
  readonly machineCode: string;
  readonly reportedAt: Date;
  readonly severity: BreakdownSeverity;
  readonly description: string;
  /** Arızanın giderildiği an. Devam ediyorsa null. */
  readonly resolvedAt?: Date | null;
}

export interface DowntimeResult {
  readonly hours: number | null;
  readonly ongoing: boolean;
  /** Üretimi durduran arıza saatleri ayrı toplanır. */
  readonly productionStopping: boolean;
}

/**
 * Duruş süresi.
 *
 * DEVAM EDEN ARIZANIN SÜRESİ "SIFIR" DEĞİL "SÜRÜYOR"DUR. Sıfır sayılsaydı
 * en pahalı arıza — hâlâ devam eden — raporda hiç görünmezdi.
 */
export function downtime(b: BreakdownInput, on: Date): DowntimeResult {
  const end = b.resolvedAt ?? on;
  const hours = Math.round(((end.getTime() - b.reportedAt.getTime()) / 3_600_000) * 10) / 10;
  return {
    hours: hours >= 0 ? hours : null,
    ongoing: !b.resolvedAt,
    productionStopping: b.severity === "durdurdu",
  };
}

export interface MaintenanceKpi {
  readonly totalOrders: number;
  readonly plannedOrders: number;
  readonly breakdownOrders: number;
  /** Planlı bakım oranı — yükseldikçe arıza azalmalıdır. */
  readonly plannedRatePercent: number | null;
  readonly totalDowntimeHours: number;
  readonly productionStoppingHours: number;
  /** Arızalar arası ortalama süre (saat). Az arıza varsa güvenilmez. */
  readonly mtbfHours: number | null;
  /** Ortalama tamir süresi (saat). */
  readonly mttrHours: number | null;
  readonly caveats: readonly string[];
}

/**
 * Bakım göstergeleri.
 *
 * MTBF VE MTTR AZ VERİYLE HESAPLANMAZ. İki arızadan MTBF çıkarmak,
 * rastlantıyı eğilim gibi sunmaktır; sayı yetersizse null döner ve
 * sebebi söylenir.
 */
export const MIN_SAMPLES_FOR_KPI = 3;

export function maintenanceKpi(input: {
  orders: readonly { kind: MaintenanceKind }[];
  breakdowns: readonly { downtimeHours: number | null; productionStopping: boolean; reportedAt: Date }[];
  periodHours: number;
}): MaintenanceKpi {
  const caveats: string[] = [];
  const planned = input.orders.filter((o) => o.kind === "planli").length;
  const breakdown = input.orders.filter((o) => o.kind === "ariza").length;

  let totalDowntime = 0;
  let stoppingDowntime = 0;
  let measured = 0;
  for (const b of input.breakdowns) {
    if (b.downtimeHours === null) continue;
    measured += 1;
    totalDowntime += b.downtimeHours;
    if (b.productionStopping) stoppingDowntime += b.downtimeHours;
  }

  if (measured < input.breakdowns.length) {
    caveats.push(
      `${input.breakdowns.length - measured} arızanın süresi ölçülemedi; duruş ` +
        `toplamı EKSİKTİR.`,
    );
  }

  let mtbf: number | null = null;
  let mttr: number | null = null;

  if (input.breakdowns.length >= MIN_SAMPLES_FOR_KPI) {
    const uptime = Math.max(0, input.periodHours - totalDowntime);
    mtbf = Math.round((uptime / input.breakdowns.length) * 10) / 10;
    mttr = measured > 0 ? Math.round((totalDowntime / measured) * 10) / 10 : null;
  } else if (input.breakdowns.length > 0) {
    caveats.push(
      `Yalnızca ${input.breakdowns.length} arıza var; MTBF ve MTTR hesaplanmadı. ` +
        `${MIN_SAMPLES_FOR_KPI} altındaki örneklemde bu göstergeler rastlantıyı ` +
        `eğilim gibi gösterir.`,
    );
  }

  const total = input.orders.length;
  return {
    totalOrders: total,
    plannedOrders: planned,
    breakdownOrders: breakdown,
    plannedRatePercent: total === 0 ? null : Math.round((planned / total) * 1000) / 10,
    totalDowntimeHours: Math.round(totalDowntime * 10) / 10,
    productionStoppingHours: Math.round(stoppingDowntime * 10) / 10,
    mtbfHours: mtbf,
    mttrHours: mttr,
    caveats,
  };
}
