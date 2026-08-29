/**
 * Parasal Decimal → JavaScript sayısı.
 *
 * PROBLEM: Postgres `Decimal(18,2)` tam sayı aritmetiğiyle çalışır;
 * JavaScript `number` ise IEEE-754 kayan noktadır. `Number(decimal)`
 * çağrısı 2^53'ü (9.007.199.254.740.991) aşan değerlerde SESSİZCE hassasiyet
 * kaybeder — 1 kuruş fark eder, sonra bir mutabakat tutmaz ve kimse nereden
 * geldiğini bulamaz.
 *
 * NEDEN HER YERİ Decimal'E ÇEVİRMİYORUZ:
 * Tool sonuçları JSON olarak modele ve tarayıcıya gidiyor; oralarda Decimal
 * diye bir tip yok. Zincirin tamamını string'e çevirmek, her tüketicide
 * ayrıştırma yükü ve yeni bir hata sınıfı demek.
 *
 * BU YÜZDEN SINIR AÇIK VE GÜRÜLTÜLÜ:
 * İki ondalıklı para birimi için güvenli üst sınır ≈ 90 trilyon. Bunu aşan
 * bir değer geldiğinde sessizce yuvarlamak yerine HATA veriyoruz. Sessiz
 * bozulmayı gürültülü bir arızaya çevirmek, bir muhasebe sisteminde her
 * zaman doğru takastır.
 */

/** İki ondalıklı bir tutarın hassasiyet kaybetmeden temsil edilebileceği üst sınır. */
export const MAX_SAFE_MONEY = Number.MAX_SAFE_INTEGER / 100;

export class MoneyPrecisionError extends Error {
  readonly code = "money_precision";
  constructor(readonly raw: string) {
    super(
      `Tutar JavaScript sayısıyla hassasiyet kaybetmeden temsil edilemiyor: ${raw}. ` +
        `Üst sınır ${MAX_SAFE_MONEY.toLocaleString("tr-TR")}.`,
    );
    this.name = "MoneyPrecisionError";
  }
}

/** Prisma Decimal benzeri; `toString()` yeterli. */
export interface DecimalLike {
  toString(): string;
}

/**
 * Parasal değeri sayıya çevirir.
 *
 * `null` → `null` olarak KALIR. Sıfıra çevirmek "tutar yok" ile "tutar sıfır"
 * ayrımını yok eder; bu ayrım sözleşme cezası gibi alanlarda farklı cevaplar
 * üretir (bkz. `shipment-source.ts`).
 */
export function toMoney(value: DecimalLike | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const raw = value.toString();
  const n = Number(raw);

  if (!Number.isFinite(n)) throw new MoneyPrecisionError(raw);
  if (Math.abs(n) > MAX_SAFE_MONEY) throw new MoneyPrecisionError(raw);

  // Kuruşa yuvarla: 0.1 + 0.2 tipi kayan nokta artıkları burada temizlenir.
  return Math.round(n * 100) / 100;
}

/**
 * Zorunlu parasal alan için — `null` gelirse hata.
 * Bakiye gibi "her zaman bir değeri olması gereken" alanlarda kullanılır.
 */
export function toMoneyRequired(value: DecimalLike | null | undefined, field: string): number {
  const n = toMoney(value);
  if (n === null) throw new Error(`${field} boş olamaz.`);
  return n;
}

/**
 * Miktar alanları (adet, kg, saat) — para değil ama aynı sorun.
 * Ondalık hane sayısı daha yüksek olabildiği için sınır daha dardır.
 */
export function toQuantity(value: DecimalLike | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const raw = value.toString();
  const n = Number(raw);
  if (!Number.isFinite(n) || Math.abs(n) > Number.MAX_SAFE_INTEGER / 10_000) {
    throw new MoneyPrecisionError(raw);
  }
  return n;
}
