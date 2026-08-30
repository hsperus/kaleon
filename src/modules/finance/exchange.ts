/**
 * Döviz kuru.
 *
 * BİLİNMEYEN KUR 1 DEĞİLDİR. Bir ERP'nin yapabileceği en pahalı sessiz
 * hata, kuru bulunamayan bir tutarı 1'le çarpıp TL sanmaktır: 126.000
 * EUR'luk bir alacak 126.000 TL olarak raporlanır, kimse fark etmez ve
 * nakit tahmini beş katı yanlış çıkar. Kur yoksa hesap YAPILMAZ.
 *
 * KUR TARİHLİDİR. "Bugünkü kur" ile "faturanın kesildiği günkü kur" farklı
 * şeylerdir; mevzuat işlem tarihindeki kuru ister. Geçmişe dönük bir
 * belgeyi bugünkü kurla değerlemek, kur farkını gizler.
 *
 * HAFTA SONU VE TATİL: TCMB yalnızca iş günlerinde kur ilan eder. Pazar
 * günkü bir işlem için Cuma kuru kullanılır — bu bir tahmin değil,
 * mevzuatın kendi kuralıdır (en son ilan edilen kur). Ama ARADAN ÇOK
 * ZAMAN GEÇMİŞSE bu kural bozulur: iki hafta önceki kur bugünü temsil
 * etmez ve sessizce kullanılmamalıdır.
 */

export const CURRENCIES = ["TRY", "USD", "EUR", "GBP", "CHF", "JPY"] as const;
export type Currency = (typeof CURRENCIES)[number];

/** Kaç gün geriye kadar en son ilan edilen kur kabul edilir. */
export const MAX_RATE_AGE_DAYS = 7;

export class ExchangeRateError extends Error {
  readonly code = "exchange_rate";
  constructor(message: string) {
    super(message);
    this.name = "ExchangeRateError";
  }
}

export interface RateQuote {
  readonly currency: string;
  /** 1 birim yabancı para kaç TL. */
  readonly rate: number;
  /** Kurun İLAN EDİLDİĞİ tarih — sorulan tarih değil. */
  readonly quotedAt: string;
  /** İstenen tarihle ilan tarihi arasındaki gün farkı. */
  readonly ageDays: number;
  readonly source: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function dayDiff(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / DAY_MS);
}

/**
 * İlan edilmiş kurlar arasından işlem tarihine uygun olanı seçer.
 *
 * İLERİ TARİHLİ KUR KULLANILMAZ. Bugünün kuru, dünkü bir faturanın
 * karşılığı değildir; seçim her zaman GERİYE bakar.
 */
export function pickRate(
  quotes: readonly { rate: number; quotedAt: Date; source: string }[],
  currency: string,
  on: Date,
): RateQuote {
  if (currency === "TRY") {
    return { currency, rate: 1, quotedAt: on.toISOString().slice(0, 10), ageDays: 0, source: "—" };
  }

  const eligible = quotes
    .filter((q) => q.quotedAt.getTime() <= on.getTime())
    .sort((a, b) => b.quotedAt.getTime() - a.quotedAt.getTime());

  const best = eligible[0];
  if (!best) {
    throw new ExchangeRateError(
      `${currency} için ${on.toISOString().slice(0, 10)} tarihine ait veya öncesine ait kur yok. ` +
        `Kur bilinmeden tutar TL'ye çevrilemez.`,
    );
  }

  const ageDays = dayDiff(best.quotedAt, on);
  if (ageDays > MAX_RATE_AGE_DAYS) {
    throw new ExchangeRateError(
      `${currency} için en son kur ${best.quotedAt.toISOString().slice(0, 10)} tarihli ` +
        `(${ageDays} gün önce). ${MAX_RATE_AGE_DAYS} günden eski kur bugünü temsil etmez; ` +
        `güncel kur girilmelidir.`,
    );
  }
  if (!(best.rate > 0)) {
    throw new ExchangeRateError(`${currency} için geçersiz kur: ${best.rate}`);
  }

  return {
    currency,
    rate: best.rate,
    quotedAt: best.quotedAt.toISOString().slice(0, 10),
    ageDays,
    source: best.source,
  };
}

/**
 * Yabancı para tutarı TL'ye çevirir.
 *
 * ÇEVRİM SONUCU KURUŞA YUVARLANIR ve hangi kurla çevrildiği çağırana
 * DÖNER: "1.250.000 TL" cevabı, hangi kurdan geldiği söylenmeden
 * denetlenebilir değildir.
 */
export function toBaseCurrency(
  amount: number,
  quote: RateQuote,
): { amount: number; rate: number; quotedAt: string } {
  const converted = Math.round(amount * quote.rate * 100) / 100;
  return { amount: converted, rate: quote.rate, quotedAt: quote.quotedAt };
}
