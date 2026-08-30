/**
 * Faturanın okunabilir hâli için yardımcılar.
 *
 * KDV KIRILIMI FATURANIN ZORUNLU PARÇASIDIR. Vergi Usul Kanunu'na göre
 * fatura, KDV'yi oran oran göstermek zorundadır: %20 ve %10 kalemleri
 * olan bir faturada tek bir toplam KDV satırı yeterli değildir, çünkü
 * alıcı indirim yaparken oranları ayırmak zorunda.
 *
 * TUTAR YAZIYLA DA YAZILIR. Türk fatura teamülünde rakamla yazılan
 * tutarın yanına yazıyla hâli konur; rakamdaki tek hane oynaması
 * yazıyla karşılaştırıldığında yakalanır.
 */

/** Kalemlerden KDV oranı kırılımı çıkarır. */
export function vatBreakdown(
  lines: readonly { netAmount: number; vatRate: number; vatAmount: number }[],
): readonly { rate: number; base: number; amount: number }[] {
  const byRate = new Map<number, { base: number; amount: number }>();
  for (const l of lines) {
    const cur = byRate.get(l.vatRate) ?? { base: 0, amount: 0 };
    cur.base += l.netAmount;
    cur.amount += l.vatAmount;
    byRate.set(l.vatRate, cur);
  }
  return [...byRate.entries()]
    .map(([rate, v]) => ({
      rate,
      base: Math.round(v.base * 100) / 100,
      amount: Math.round(v.amount * 100) / 100,
    }))
    // Oran sırası: küçükten büyüğe — faturada okuyanın beklediği sıra.
    .sort((a, b) => a.rate - b.rate);
}

const ONES = ["", "bir", "iki", "üç", "dört", "beş", "altı", "yedi", "sekiz", "dokuz"];
const TENS = ["", "on", "yirmi", "otuz", "kırk", "elli", "altmış", "yetmiş", "seksen", "doksan"];
const SCALES = ["", "bin", "milyon", "milyar", "trilyon"];

/** Üç haneli grubu yazıya çevirir. */
function trio(n: number, scaleIndex: number): string {
  if (n === 0) return "";
  const h = Math.floor(n / 100);
  const t = Math.floor((n % 100) / 10);
  const o = n % 10;
  let s = "";
  // "biryüz" denmez, "yüz" denir.
  if (h > 0) s += (h === 1 ? "" : ONES[h]) + "yüz";
  s += TENS[t]!;
  s += ONES[o]!;
  // "birbin" de denmez, "bin" denir — ama "birmilyon" denir.
  if (scaleIndex === 1 && n === 1) return "bin";
  return s + SCALES[scaleIndex]!;
}

const CURRENCY_WORD: Record<string, { major: string; minor: string }> = {
  TRY: { major: "TürkLirası", minor: "Kuruş" },
  USD: { major: "ABDDoları", minor: "Sent" },
  EUR: { major: "Euro", minor: "Sent" },
};

/**
 * Tutarı yazıya çevirir: 1.234,56 TRY → "BinİkiYüzOtuzDörtTürkLirasıElliAltıKuruş".
 *
 * BÜYÜK HARF YOK, BOŞLUK YOK — Türk fatura teamülünde tutar bitişik
 * yazılır ve araya boşluk konursa rakam eklenebilir hâle gelir. Bitişik
 * yazım tam olarak bunu engellemek içindir.
 */
export function amountInWords(amount: number, currency: string): string {
  if (!Number.isFinite(amount)) return "";
  const neg = amount < 0;
  const abs = Math.abs(Math.round(amount * 100) / 100);
  const major = Math.floor(abs);
  const minor = Math.round((abs - major) * 100);

  const words = (n: number): string => {
    if (n === 0) return "sıfır";
    const groups: number[] = [];
    let rest = n;
    while (rest > 0) {
      groups.push(rest % 1000);
      rest = Math.floor(rest / 1000);
    }
    // Kapasite sınırı: trilyonun ötesi bir fatura tutarı değildir ve
    // sessizce yanlış yazmaktansa rakamı olduğu gibi bırakmak yeğdir.
    if (groups.length > SCALES.length) return String(n);
    return groups
      .map((g, i) => trio(g, i))
      .reverse()
      .join("");
  };

  const c = CURRENCY_WORD[currency] ?? { major: currency, minor: "" };
  let out = words(major) + c.major;
  if (minor > 0 && c.minor) out += words(minor) + c.minor;
  return (neg ? "eksi" : "") + out;
}
