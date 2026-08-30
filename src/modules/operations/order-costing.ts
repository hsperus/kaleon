/**
 * İş emri maliyeti.
 *
 * "BU ÜRÜN BİZE KAÇA MAL OLUYOR" SORUSU BURADA CEVAPLANIR. Satış fiyatı
 * bilinir, hammadde fiyatı bilinir; arada kaybolan işçilik, fire ve genel
 * üretim gideri hesaplanmazsa kârlılık bir tahmin olarak kalır.
 *
 * ÜÇ MALİYET UNSURU, ÜÇ AYRI HESAP (Tek Düzen 7/A):
 *   710 Direkt İlk Madde ve Malzeme — iş emrine sarf edilen malzeme
 *   720 Direkt İşçilik              — operasyonlarda harcanan süre × ücret
 *   730 Genel Üretim Giderleri      — yükleme oranıyla dağıtılan pay
 * Üçü toplanıp 151 Yarı Mamuller'e, üretim bitince 152 Mamuller'e geçer.
 *
 * FİİLİ İLE STANDART AYRI TUTULUR. Yalnızca fiili tutulsaydı, "pahalıya
 * mal oldu" denebilir ama NEDEN pahalıya mal olduğu bilinemezdi. Fark
 * ayrıştırılınca cevap belirir: fazla malzeme mi harcandı, fazla süre mi
 * geçti, yoksa alım fiyatı mı yükseldi?
 *
 * MALİYETİ BİLİNMEYEN UNSUR SIFIR SAYILMAZ. İşçilik ücreti tanımlı
 * değilse "işçilik sıfır" demek, ürünü olduğundan ucuz gösterir ve
 * fiyatlandırmayı bozar — bu, sistemin verebileceği en pahalı yanlıştır.
 */

export class CostingError extends Error {
  readonly code = "costing";
  constructor(message: string) {
    super(message);
    this.name = "CostingError";
  }
}

export interface MaterialConsumption {
  readonly itemCode: string;
  readonly quantity: number;
  /** Hareket anındaki maliyet. BİLİNMİYORSA null. */
  readonly value: number | null;
}

export interface LaborEntry {
  readonly workCenter: string;
  readonly hours: number;
  /** Saatlik maliyet. Tanımsızsa null — sıfır DEĞİL. */
  readonly hourlyRate: number | null;
}

export interface CostBreakdown {
  readonly material: number;
  readonly labor: number;
  readonly overhead: number;
  readonly total: number;
  /** Değeri bilinemeyen unsurlar — toplama girmez, ayrı sayılır. */
  readonly unknowns: readonly string[];
}

/**
 * Genel üretim giderleri yükleme oranı.
 *
 * Direkt işçilik üzerinden yüklenir; imalat KOBİ'sinde en yaygın ve en
 * anlaşılır yöntem budur. Oran tanımlı değilse GÜG HESAPLANMAZ ve bu
 * söylenir — uydurma bir oran, maliyeti sistematik olarak yanlış yapar.
 */
export interface OverheadPolicy {
  /** İşçilik maliyetinin yüzdesi olarak. Tanımsızsa null. */
  readonly rateOnLaborPercent: number | null;
}

export function accumulate(input: {
  materials: readonly MaterialConsumption[];
  labor: readonly LaborEntry[];
  overhead: OverheadPolicy;
}): CostBreakdown {
  const unknowns: string[] = [];

  let material = 0;
  for (const m of input.materials) {
    if (m.value === null) {
      unknowns.push(`${m.itemCode}: sarf edilen malzemenin maliyeti bilinmiyor`);
      continue;
    }
    material += m.value;
  }

  let labor = 0;
  let laborKnown = true;
  for (const l of input.labor) {
    if (l.hourlyRate === null) {
      unknowns.push(`${l.workCenter}: saatlik işçilik maliyeti tanımlı değil`);
      laborKnown = false;
      continue;
    }
    labor += l.hours * l.hourlyRate;
  }

  let overhead = 0;
  if (input.overhead.rateOnLaborPercent === null) {
    if (input.labor.length > 0) {
      unknowns.push("Genel üretim gideri yükleme oranı tanımlı değil");
    }
  } else if (!laborKnown) {
    unknowns.push(
      "İşçilik eksik olduğu için genel üretim gideri de eksik hesaplandı",
    );
    overhead = round2(labor * (input.overhead.rateOnLaborPercent / 100));
  } else {
    overhead = round2(labor * (input.overhead.rateOnLaborPercent / 100));
  }

  material = round2(material);
  labor = round2(labor);

  return { material, labor, overhead, total: round2(material + labor + overhead), unknowns };
}

export interface VarianceInput {
  readonly quantityProduced: number;
  readonly actual: CostBreakdown;
  /** Standart birim maliyet. Tanımsızsa fark hesaplanamaz. */
  readonly standardUnitCost: number | null;
}

export interface Variance {
  readonly actualUnitCost: number | null;
  readonly standardUnitCost: number | null;
  readonly unitVariance: number | null;
  readonly totalVariance: number | null;
  readonly variancePercent: number | null;
  /** Fark ne kadar büyük — yorumu çağırana bırakmamak için. */
  readonly severity: "yok" | "kabul" | "dikkat" | "kritik";
  readonly explanation: string;
}

/** Sapma eşikleri — yüzde. */
export const VARIANCE_ATTENTION = 5;
export const VARIANCE_CRITICAL = 15;

/**
 * Fiili maliyeti standartla karşılaştırır.
 *
 * SIFIRA BÖLME VE BİLİNMEYEN AYRI AYRI ELE ALINIR: üretim miktarı sıfırsa
 * birim maliyet yoktur (hesaplanamaz), standart tanımsızsa karşılaştırma
 * yoktur (bilinmiyor). İkisini "0" diye göstermek iki farklı gerçeği
 * aynı yalana çevirir.
 */
export function variance(input: VarianceInput): Variance {
  if (!(input.quantityProduced > 0)) {
    return {
      actualUnitCost: null,
      standardUnitCost: input.standardUnitCost,
      unitVariance: null,
      totalVariance: null,
      variancePercent: null,
      severity: "yok",
      explanation: "Henüz üretim yok; birim maliyet hesaplanamaz.",
    };
  }

  const actualUnitCost = round4(input.actual.total / input.quantityProduced);

  if (input.standardUnitCost === null) {
    return {
      actualUnitCost,
      standardUnitCost: null,
      unitVariance: null,
      totalVariance: null,
      variancePercent: null,
      severity: "yok",
      explanation:
        "Standart maliyet tanımlı değil; fiili maliyet hesaplandı ama karşılaştırma " +
        "yapılamıyor. Sapmanın büyük olup olmadığı BİLİNMİYOR.",
    };
  }

  const unitVariance = round4(actualUnitCost - input.standardUnitCost);
  const totalVariance = round2(unitVariance * input.quantityProduced);
  const variancePercent =
    input.standardUnitCost === 0
      ? null
      : round2((unitVariance / input.standardUnitCost) * 100);

  const abs = Math.abs(variancePercent ?? 0);
  const severity =
    variancePercent === null
      ? "yok"
      : abs >= VARIANCE_CRITICAL
        ? "kritik"
        : abs >= VARIANCE_ATTENTION
          ? "dikkat"
          : "kabul";

  const direction = unitVariance > 0 ? "pahalıya" : "ucuza";
  const explanation =
    unitVariance === 0
      ? "Fiili maliyet standartla aynı."
      : `Birim maliyet standardın %${Math.abs(variancePercent ?? 0)} ${direction} geldi ` +
        `(standart ${input.standardUnitCost}, fiili ${actualUnitCost}); ` +
        `toplam fark ${totalVariance}.`;

  return {
    actualUnitCost,
    standardUnitCost: input.standardUnitCost,
    unitVariance,
    totalVariance,
    variancePercent,
    severity,
    explanation,
  };
}

/**
 * Farkın hangi unsurdan geldiğini gösterir.
 *
 * "Pahalıya mal oldu" cümlesi tek başına hiçbir karar verdirmez; malzeme
 * mi fazla harcandı, süre mi uzadı sorusunun cevabı eylemi belirler.
 */
export function varianceByElement(
  actual: CostBreakdown,
  standard: { material: number; labor: number; overhead: number } | null,
): readonly { element: string; actual: number; standard: number | null; variance: number | null }[] {
  const rows = [
    { element: "Direkt malzeme (710)", actual: actual.material, standard: standard?.material ?? null },
    { element: "Direkt işçilik (720)", actual: actual.labor, standard: standard?.labor ?? null },
    { element: "Genel üretim gideri (730)", actual: actual.overhead, standard: standard?.overhead ?? null },
  ];
  return rows.map((r) => ({
    ...r,
    variance: r.standard === null ? null : round2(r.actual - r.standard),
  }));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
