/**
 * Türkçe-duyarlı ad normalizasyonu.
 *
 * Bu dosyadaki en önemli ayrıntı bir dil tuzağıdır: JavaScript'te
 * `"BURÇELİK".toLowerCase()` → "burçeli̇k" üretir — "İ" harfi, ayrı bir
 * birleşen nokta (U+0307) bırakarak küçülür. Bu görünmez karakter iki kaydın
 * asla eşleşmemesine yol açar. `toLocaleLowerCase("tr")` doğru sonucu verir;
 * ayrıca aşağıda Unicode normalizasyonu ile artık birleşenler temizlenir.
 */

/** Türkçe harflerin eşleştirme için ASCII karşılıkları. */
const FOLD: Record<string, string> = {
  ç: "c", ğ: "g", ı: "i", i: "i", ö: "o", ş: "s", ü: "u",
  â: "a", î: "i", û: "u", ô: "o", ê: "e",
};

/**
 * Tüzel kişilik ekleri ve jenerik sektör kelimeleri.
 * "Burçelik Bursa Çelik Döküm Sanayi A.Ş." → çekirdek: "burcelik bursa celik dokum"
 */
const LEGAL_TOKENS = new Set([
  "as", "a", "s", "anonim", "sirketi", "sirket",
  "ltd", "limited", "sti", "stii",
  "kollektif", "koll", "komandit", "adi", "ortakligi",
  "holding", "grup", "group", "inc", "llc", "gmbh", "bv", "sa", "spa", "ab", "oy",
  "ve", "and",
]);

/** Sektör jenerikleri — ayırt edici değil, çekirdekten düşülür. */
const GENERIC_TOKENS = new Set([
  "sanayi", "san", "ticaret", "tic", "sanayii",
  "insaat", "muhendislik", "muhendislilk", "makina", "makine",
  "imalat", "uretim", "pazarlama", "dis", "ic",
  "ithalat", "ihracat", "lojistik", "nakliyat", "tasimacilik",
]);

export interface NormalizedName {
  /** Katlanmış, noktalama temizlenmiş tam ad. */
  readonly full: string;
  /** Tüzel ek ve sektör jenerikleri düşülmüş ayırt edici çekirdek. */
  readonly core: string;
  /** Çekirdeğin token kümesi. */
  readonly tokens: readonly string[];
}

/** Türkçe küçültme + Unicode temizliği + ASCII katlama. */
export function fold(input: string): string {
  const lowered = input
    .toLocaleLowerCase("tr")
    // "İ" küçülürken bıraktığı birleşen noktayı (U+0307) at.
    .normalize("NFD")
    .replace(/̇/g, "")
    .normalize("NFC");

  let out = "";
  for (const ch of lowered) out += FOLD[ch] ?? ch;
  return out
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .normalize("NFC");
}

export function normalizeName(input: string): NormalizedName {
  const folded = fold(input)
    .replace(/[.,;:'"`´()[\]{}/\\|+*_-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const allTokens = folded.split(" ").filter(Boolean);
  const core = allTokens.filter(
    (t) => !LEGAL_TOKENS.has(t) && !GENERIC_TOKENS.has(t) && t.length > 1,
  );

  // Her şey elendiyse tam adı çekirdek kabul et — boş çekirdek eşleşme üretmez.
  const tokens = core.length > 0 ? core : allTokens;

  return {
    full: allTokens.join(" "),
    core: tokens.join(" "),
    tokens,
  };
}

/** Jaro-Winkler benzerliği — yazım hataları ve kısaltmalar için. */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;

  const matchWindow = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aFlags = new Array<boolean>(a.length).fill(false);
  const bFlags = new Array<boolean>(b.length).fill(false);
  let matches = 0;

  for (let i = 0; i < a.length; i++) {
    const start = Math.max(0, i - matchWindow);
    const end = Math.min(i + matchWindow + 1, b.length);
    for (let j = start; j < end; j++) {
      if (bFlags[j] || a[i] !== b[j]) continue;
      aFlags[i] = true;
      bFlags[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;

  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aFlags[i]) continue;
    while (!bFlags[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  transpositions /= 2;

  const jaro =
    (matches / a.length + matches / b.length + (matches - transpositions) / matches) / 3;

  // Winkler eki: ortak önek eşleşmeyi güçlendirir (en fazla 4 karakter).
  let prefix = 0;
  for (let i = 0; i < Math.min(4, a.length, b.length); i++) {
    if (a[i] === b[i]) prefix++;
    else break;
  }
  return jaro + prefix * 0.1 * (1 - jaro);
}

/** Token kümesi örtüşmesi (Jaccard). Kelime sırasından bağımsızdır. */
export function tokenSimilarity(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const t of setA) if (setB.has(t)) intersection++;
  return intersection / (setA.size + setB.size - intersection);
}

/**
 * Bulanık token benzerliği.
 *
 * Jaccard tam eşleşme arar; gerçek veride ("Burcelk" ↔ "Burçelik") bu yetmez.
 * Entegratör aktarımları, OCR çıktıları ve elle giriş birden fazla kelimede
 * birden hata içerir ve keskin Jaccard skoru çökertir. Burada her token,
 * karşı taraftaki en iyi eşine Jaro-Winkler ile eşlenir ve skorlar
 * ortalanır — iki yönde de hesaplanıp küçüğü alınır (asimetri koruması).
 */
export function fuzzyTokenSimilarity(
  a: readonly string[],
  b: readonly string[],
  floor = 0.82,
): number {
  if (a.length === 0 || b.length === 0) return 0;

  const directional = (from: readonly string[], to: readonly string[]): number => {
    let total = 0;
    for (const token of from) {
      let best = 0;
      for (const other of to) {
        const score = jaroWinkler(token, other);
        if (score > best) best = score;
      }
      total += best >= floor ? best : 0;
    }
    return total / from.length;
  };

  return Math.min(directional(a, b), directional(b, a));
}

/** Biri diğerini tamamen kapsıyor mu? ("Burçelik" ⊂ "Burçelik Bursa Çelik Döküm") */
export function isTokenSubset(a: readonly string[], b: readonly string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  const [small, large] = a.length <= b.length ? [a, b] : [b, a];
  const set = new Set(large);
  return small.every((t) => set.has(t));
}
