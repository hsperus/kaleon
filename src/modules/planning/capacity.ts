/**
 * Kapasite planlama.
 *
 * MRP MALZEMEYİ PLANLAR, TEZGÂHI PLANLAMAZ. Malzeme zamanında gelse bile
 * kaynak makinesi üç vardiya dolu ise iş yetişmez. Bu yüzden MRP'nin
 * ürettiği plan, kapasiteye karşı kontrol edilmeden bir taahhüt sayılmaz.
 *
 * SONSUZ KAPASİTE VARSAYIMI EN YAYGIN PLANLAMA YALANIDIR. Sistem her
 * siparişi kabul eder, her termin verilir, sonra üretim "yetiştiremedik"
 * der. Kapasite kontrolü bu yalanı ölçülebilir hâle getirir: yükleme
 * oranı %100'ü aştığı gün bellidir.
 *
 * KAPASİTE TANIMSIZSA DOLULUK HESAPLANMAZ. "%0 dolu" demek, boş bir
 * tezgâh göstermek ve o tezgâha iş yığmaktır.
 */

export class CapacityError extends Error {
  readonly code = "capacity";
  constructor(message: string) {
    super(message);
    this.name = "CapacityError";
  }
}

export interface WorkCenterCapacity {
  readonly code: string;
  readonly name: string;
  /** Günlük kullanılabilir saat. Tanımsızsa null — sıfır DEĞİL. */
  readonly dailyHours: number | null;
  /** Aynı anda işlenebilecek iş sayısı. */
  readonly concurrent: number | null;
}

export interface CapacityDemand {
  readonly workCenter: string;
  /** Gereken süre (saat). */
  readonly hours: number;
  readonly dueDate: Date;
  readonly source: string;
}

export interface LoadBucket {
  readonly workCenter: string;
  readonly date: string;
  readonly requiredHours: number;
  readonly availableHours: number | null;
  readonly loadPercent: number | null;
  readonly overloaded: boolean;
  readonly sources: readonly string[];
}

export interface CapacityResult {
  readonly buckets: readonly LoadBucket[];
  readonly overloaded: readonly LoadBucket[];
  readonly caveats: readonly string[];
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Yükleme profili: iş merkezi × gün.
 *
 * TALEP TESLİM GÜNÜNE YAZILIR, dağıtılmaz. Dağıtmak (örneğin geriye
 * doğru yaymak) daha "gerçekçi" görünür ama tahmindir; teslim gününe
 * yazmak, en kötü durumu ve gerçek sıkışıklığı gösterir.
 */
export function loadProfile(input: {
  centers: readonly WorkCenterCapacity[];
  demands: readonly CapacityDemand[];
}): CapacityResult {
  const caveats: string[] = [];
  const byCode = new Map(input.centers.map((c) => [c.code, c]));
  const buckets = new Map<string, LoadBucket & { sourceSet: Set<string> }>();

  for (const d of input.demands) {
    const center = byCode.get(d.workCenter);
    if (!center) {
      caveats.push(
        `"${d.workCenter}" iş merkezi tanımlı değil; ${d.source} yükü PLANA GİRMEDİ. ` +
          `Görünmeyen yük, sıkışıklığı olduğundan az gösterir.`,
      );
      continue;
    }

    const key = `${d.workCenter}|${iso(d.dueDate)}`;
    const existing = buckets.get(key);
    if (existing) {
      buckets.set(key, {
        ...existing,
        requiredHours: Math.round((existing.requiredHours + d.hours) * 100) / 100,
        sourceSet: existing.sourceSet.add(d.source),
      });
      continue;
    }

    buckets.set(key, {
      workCenter: d.workCenter,
      date: iso(d.dueDate),
      requiredHours: Math.round(d.hours * 100) / 100,
      availableHours: center.dailyHours,
      loadPercent: null,
      overloaded: false,
      sources: [],
      sourceSet: new Set([d.source]),
    });
  }

  const undefinedCapacity = new Set<string>();
  const rows: LoadBucket[] = [];

  for (const b of buckets.values()) {
    // KAPASİTE TANIMSIZSA DOLULUK HESAPLANMAZ. "%0 dolu" demek boş bir
    // tezgâh göstermek ve o tezgâha iş yığmaktır.
    if (b.availableHours === null || b.availableHours <= 0) {
      undefinedCapacity.add(b.workCenter);
      rows.push({
        workCenter: b.workCenter,
        date: b.date,
        requiredHours: b.requiredHours,
        availableHours: null,
        loadPercent: null,
        overloaded: false,
        sources: [...b.sourceSet],
      });
      continue;
    }

    const loadPercent = Math.round((b.requiredHours / b.availableHours) * 1000) / 10;
    rows.push({
      workCenter: b.workCenter,
      date: b.date,
      requiredHours: b.requiredHours,
      availableHours: b.availableHours,
      loadPercent,
      overloaded: loadPercent > 100,
      sources: [...b.sourceSet],
    });
  }

  for (const code of undefinedCapacity) {
    caveats.push(
      `"${code}" iş merkezinin günlük kapasitesi tanımlı değil; doluluk oranı ` +
        `HESAPLANAMADI. Sıfır doluluk boş bir tezgâh demektir ve yanlış karar verdirir.`,
    );
  }

  rows.sort((a, b) => a.date.localeCompare(b.date) || a.workCenter.localeCompare(b.workCenter));
  const over = rows.filter((r) => r.overloaded).sort((a, b) => (b.loadPercent ?? 0) - (a.loadPercent ?? 0));

  if (over.length > 0) {
    caveats.push(
      `${over.length} gün-iş merkezi kombinasyonunda kapasite AŞILIYOR; bu işler ` +
        `zamanında bitmez.`,
    );
  }

  return { buckets: rows, overloaded: over, caveats };
}

/**
 * Bir işin gereken süresini hedef hızdan türetir.
 *
 * HEDEF HIZ TANIMSIZSA SÜRE HESAPLANMAZ. Varsayılan bir hız uydurmak,
 * kapasite planını tamamen hayalî yapar.
 */
export function requiredHours(quantity: number, targetRatePerHour: number | null): number | null {
  if (targetRatePerHour === null || targetRatePerHour <= 0) return null;
  return Math.round((quantity / targetRatePerHour) * 100) / 100;
}
