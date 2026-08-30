/**
 * Amortisman hesabı — VUK'a göre.
 *
 * SAP'DE ASSET ACCOUNTING AYRI BİR MODÜLDÜR ve kurulumu haftalar
 * sürer; burada Türk mevzuatının kuralları HAZIR GELİR. Yerelleşmenin
 * en somut kazancı budur: amortisman oranı, kıst uygulaması ve azalan
 * bakiyeler tavanı Vergi Usul Kanunu'nda yazar, her projede yeniden
 * yorumlanacak bir şey değildir.
 *
 * ÜÇ KURAL, HESABIN TAMAMINI BELİRLER:
 *
 *  1. NORMAL YÖNTEM (VUK 315). Maliyet, faydalı ömre eşit bölünür.
 *     Yıllık oran = 1 / faydalı ömür.
 *
 *  2. AZALAN BAKİYELER (VUK mükerrer 315). Oran normalin İKİ KATIDIR
 *     ama %50'yi GEÇEMEZ. Son yılda kalan değerin tamamı yazılır —
 *     aksi hâlde varlık hiçbir zaman tam amorti olmaz, çünkü kalan
 *     bakiyenin yüzdesi her yıl sıfıra yaklaşır ama sıfır olmaz.
 *
 *  3. KIST AMORTİSMAN (VUK 320). Binek otomobillerde, iktisap edildiği
 *     yıl için yalnızca kalan AY sayısı kadar amortisman ayrılır ve ay
 *     kesri TAM AY sayılır. Diğer kıymetlerde yılın tamamı ayrılır.
 *
 * KALINTI DEĞER TÜRKİYE'DE YOKTUR. Uluslararası standartlarda varlığın
 * ömrü sonundaki tahmini değeri düşülür; VUK bunu tanımaz ve varlık
 * sıfıra kadar amorti edilir. Bu alan bilerek YOK — olsaydı kullanıcı
 * doldurur ve vergi matrahı yanlış çıkardı.
 */

export type Method = "normal" | "azalan";

export class DepreciationError extends Error {
  readonly code = "depreciation";
  constructor(message: string) {
    super(message);
    this.name = "DepreciationError";
  }
}

export interface AssetInput {
  /** Amortismana esas bedel — KDV hariç, giderler dahil. */
  readonly cost: number;
  /** Faydalı ömür, YIL. Maliye Bakanlığı listesinden gelir. */
  readonly usefulLifeYears: number;
  readonly method: Method;
  /** İktisap tarihi. */
  readonly acquiredAt: Date;
  /**
   * Kıst amortismana tabi mi — binek otomobil için true.
   *
   * VUK 320 yalnızca binek otomobilleri sayar; makineye kıst
   * uygulamak amortismanı eksik ayırmak, uygulamamak fazla ayırmaktır.
   */
  readonly prorated: boolean;
}

export interface YearRow {
  readonly year: number;
  /** O yıl ayrılan amortisman. */
  readonly amount: number;
  /** Yıl sonu birikmiş amortisman. */
  readonly accumulated: number;
  /** Yıl sonu net defter değeri. */
  readonly bookValue: number;
  /** Kaç ay için ayrıldı (kıst yılında 12'den az). */
  readonly months: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Yıllık amortisman oranı.
 *
 * Azalan bakiyelerde tavan %50'dir: faydalı ömrü 3 yıl olan bir
 * kıymette normal oran %33,33, iki katı %66,67 olurdu — kanun buna
 * izin vermez.
 */
export function annualRate(usefulLifeYears: number, method: Method): number {
  if (usefulLifeYears <= 0) {
    throw new DepreciationError("Faydalı ömür sıfır ya da negatif olamaz.");
  }
  const normal = 1 / usefulLifeYears;
  return method === "normal" ? normal : Math.min(normal * 2, 0.5);
}

/**
 * Amortisman tablosu — varlığın ömrü boyunca yıl yıl.
 *
 * Tablo, tek bir yılın tutarını hesaplamaktan fazlasını verir:
 * kullanıcı "bu makine ne zaman biter" diye sorduğunda cevap budur ve
 * bütçe planlaması bu tabloya dayanır.
 */
export function schedule(a: AssetInput): readonly YearRow[] {
  if (a.cost <= 0) throw new DepreciationError("Amortismana esas bedel pozitif olmalıdır.");
  if (!Number.isInteger(a.usefulLifeYears) || a.usefulLifeYears < 1) {
    throw new DepreciationError("Faydalı ömür tam yıl olmalıdır.");
  }

  const rate = annualRate(a.usefulLifeYears, a.method);
  const startYear = a.acquiredAt.getUTCFullYear();
  // Ay kesri TAM AY sayılır: 15 Mart'ta alınan kıymet için 10 ay.
  const firstYearMonths = a.prorated ? 12 - a.acquiredAt.getUTCMonth() : 12;

  const rows: YearRow[] = [];
  let accumulated = 0;
  let bookValue = a.cost;

  // Kıst uygulanan yılda yazılamayan kısım ÖMRÜN SONUNA EKLENİR
  // (VUK 320): ilk yıl eksik ayrılan amortisman kaybolmaz.
  const maxYears = a.usefulLifeYears + (firstYearMonths < 12 ? 1 : 0);

  for (let i = 0; i < maxYears; i += 1) {
    if (bookValue <= 0.005) break;

    const months = i === 0 ? firstYearMonths : 12;
    let amount =
      a.method === "normal"
        ? (a.cost * rate * months) / 12
        : (bookValue * rate * months) / 12;

    // SON YIL KALANIN TAMAMI YAZILIR. Azalan bakiyelerde bu olmasaydı
    // varlık hiçbir zaman sıfırlanmaz, defterde sonsuza kadar küçülen
    // bir bakiye kalırdı.
    const isLast = i === maxYears - 1;
    if (isLast || amount > bookValue) amount = bookValue;

    amount = round2(amount);
    accumulated = round2(accumulated + amount);
    bookValue = round2(a.cost - accumulated);

    rows.push({ year: startYear + i, amount, accumulated, bookValue, months });
  }

  return rows;
}

/**
 * Belirli bir yılın amortismanı.
 *
 * SIFIR DÖNMEK İLE "BU YIL AMORTİSMAN YOK" AYNI ŞEY DEĞİLDİR: varlık o
 * yıl henüz alınmamışsa ya da çoktan bitmişse `null` döner ve çağıran
 * bunu kayıt yazmama sebebi olarak kullanır. Sıfır yazılsaydı defterde
 * tutarsız bir fiş oluşurdu.
 */
export function forYear(a: AssetInput, year: number): YearRow | null {
  return schedule(a).find((r) => r.year === year) ?? null;
}

/**
 * Elden çıkarma sonucu.
 *
 * KÂR/ZARAR NET DEFTER DEĞERİNE GÖRE HESAPLANIR, maliyete göre değil.
 * Maliyete göre hesaplanırsa yıllardır ayrılan amortisman yok sayılır
 * ve her satış zarar gösterir.
 */
export function disposalResult(
  cost: number,
  accumulated: number,
  proceeds: number,
): { bookValue: number; gain: number } {
  const bookValue = round2(cost - accumulated);
  return { bookValue, gain: round2(proceeds - bookValue) };
}
