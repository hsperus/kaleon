/**
 * Satış kalemi fiyatlandırması ve KDV.
 *
 * PARA HESABI KURUŞTA YAPILIR. `0.1 + 0.2 !== 0.3` olduğu için, tutarları
 * kayan noktada toplayıp sonunda yuvarlamak 4000 kalemlik bir faturada
 * kuruş kayması bırakır ve mutabakat tutmaz. Her satır KENDİ İÇİNDE kuruşa
 * yuvarlanır, toplamlar yuvarlanmış kuruşlar üzerinden tam sayı olarak
 * toplanır.
 *
 * KDV SATIR BAZINDA HESAPLANIR, TOPLAM ÜZERİNDEN DEĞİL. Farklı oranlardaki
 * kalemler (%1 gıda, %20 genel) tek bir toplama uygulanamaz; ayrıca
 * Türkiye'de fatura üzerinde KDV oranı kırılımı gösterilmek zorundadır.
 *
 * İSKONTO KDV MATRAHINI DÜŞÜRÜR. İskonto sonrası net tutar matrahtır;
 * KDV'yi brüt üzerinden hesaplamak müşteriden fazla KDV tahsil etmektir.
 */

/** Türkiye'de yürürlükteki KDV oranları. Başka bir oran yazım hatasıdır. */
export const VAT_RATES = [0, 1, 10, 20] as const;

export class PricingError extends Error {
  readonly code = "pricing_invalid";
  constructor(message: string) {
    super(message);
    this.name = "PricingError";
  }
}

/**
 * Kuruşa yuvarlar — yarımı yukarı, işaretten bağımsız.
 *
 * `Math.round(-2.5)` JavaScript'te -2 verir (yukarı), oysa muhasebede
 * mutlak değere göre yuvarlanır: -2.5 → -3. İade faturalarında bu fark
 * kuruş bırakır.
 */
export function toKurus(amount: number): number {
  if (!Number.isFinite(amount)) {
    throw new PricingError(`Geçersiz tutar: ${amount}`);
  }
  // 1e-9 payı, 0.615 gibi ikilik tabanda 0.61499999… olarak duran
  // değerlerin bir aşağı yuvarlanmasını engeller.
  const scaled = amount * 100;
  const rounded = Math.sign(scaled) * Math.round(Math.abs(scaled) + 1e-9);
  return Object.is(rounded, -0) ? 0 : rounded;
}

/** Kuruştan para birimine — yalnızca gösterim ve kayıt için. */
export function fromKurus(kurus: number): number {
  return kurus / 100;
}

export interface LineInput {
  readonly quantity: number;
  readonly unitPrice: number;
  /** Yüzde olarak iskonto. 0..100. */
  readonly discountPercent?: number;
  readonly vatRate: number;
}

export interface LineAmounts {
  /** İskonto öncesi brüt — kuruş. */
  readonly grossKurus: number;
  readonly discountKurus: number;
  /** KDV matrahı — kuruş. */
  readonly netKurus: number;
  readonly vatKurus: number;
  readonly totalKurus: number;
}

/** Bir satırın tutarlarını hesaplar. Her ara değer kuruşa oturur. */
export function priceLine(line: LineInput): LineAmounts {
  if (!(line.quantity > 0)) {
    throw new PricingError("Miktar sıfırdan büyük olmalıdır.");
  }
  if (line.unitPrice < 0) {
    throw new PricingError("Birim fiyat negatif olamaz.");
  }
  const discount = line.discountPercent ?? 0;
  if (discount < 0 || discount >= 100) {
    throw new PricingError(`İskonto %0 ile %100 arasında olmalıdır: ${discount}`);
  }
  if (!(VAT_RATES as readonly number[]).includes(line.vatRate)) {
    throw new PricingError(
      `Geçersiz KDV oranı: %${line.vatRate}. Geçerli oranlar: ${VAT_RATES.join(", ")}`,
    );
  }

  const grossKurus = toKurus(line.quantity * line.unitPrice);
  const discountKurus = toKurus(fromKurus(grossKurus) * (discount / 100));
  const netKurus = grossKurus - discountKurus;
  const vatKurus = toKurus(fromKurus(netKurus) * (line.vatRate / 100));

  return {
    grossKurus,
    discountKurus,
    netKurus,
    vatKurus,
    totalKurus: netKurus + vatKurus,
  };
}

export interface VatBreakdown {
  readonly rate: number;
  readonly baseKurus: number;
  readonly vatKurus: number;
}

export interface DocumentTotals {
  readonly netKurus: number;
  readonly discountKurus: number;
  readonly vatKurus: number;
  readonly totalKurus: number;
  /** Orana göre kırılım — fatura üzerinde gösterilmesi zorunludur. */
  readonly vatBreakdown: readonly VatBreakdown[];
}

/**
 * Belge toplamı — satır tutarlarının tam sayı toplamı.
 *
 * Toplamlar YENİDEN HESAPLANMAZ, satırlardan toplanır. Yeniden hesaplamak,
 * satırda gösterilen tutarla belgede yazan tutarın birbirini tutmadığı
 * klasik "1 kuruş farkı" şikâyetini üretir.
 */
export function documentTotals(
  lines: readonly { amounts: LineAmounts; vatRate: number }[],
): DocumentTotals {
  const byRate = new Map<number, { baseKurus: number; vatKurus: number }>();
  let netKurus = 0;
  let discountKurus = 0;
  let vatKurus = 0;

  for (const l of lines) {
    netKurus += l.amounts.netKurus;
    discountKurus += l.amounts.discountKurus;
    vatKurus += l.amounts.vatKurus;

    const bucket = byRate.get(l.vatRate) ?? { baseKurus: 0, vatKurus: 0 };
    bucket.baseKurus += l.amounts.netKurus;
    bucket.vatKurus += l.amounts.vatKurus;
    byRate.set(l.vatRate, bucket);
  }

  return {
    netKurus,
    discountKurus,
    vatKurus,
    totalKurus: netKurus + vatKurus,
    vatBreakdown: [...byRate.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([rate, b]) => ({ rate, baseKurus: b.baseKurus, vatKurus: b.vatKurus })),
  };
}
