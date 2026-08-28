/**
 * Türk vergi ve kimlik numarası doğrulaması.
 *
 * Neden checksum doğrulaması? Entity resolution'ın en güçlü anahtarı vergi
 * numarasıdır — iki kaydı kesin olarak birleştirir. Ama entegratörden gelen
 * alan bazen boş, bazen "1234567890" gibi dolgu, bazen hatalı okunmuş olur.
 * Geçersiz bir numarayla yapılan "kesin" eşleşme, iki farklı firmayı
 * birleştirir ve bunu geri almak çok pahalıdır. Bu yüzden checksum geçmeyen
 * numara deterministik anahtar olarak KULLANILMAZ.
 */

export type TaxIdKind = "vkn" | "tckn" | "vat";

export interface ParsedTaxId {
  readonly kind: TaxIdKind;
  readonly value: string;
  readonly valid: boolean;
}

const digitsOnly = (s: string): string => s.replace(/\D/g, "");

/**
 * Vergi Kimlik Numarası (10 hane) checksum'ı.
 * Gelir İdaresi Başkanlığı'nın tanımladığı algoritma.
 */
export function isValidVkn(input: string): boolean {
  const v = digitsOnly(input);
  if (v.length !== 10) return false;
  if (/^(\d)\1{9}$/.test(v)) return false; // 0000000000 gibi dolgu

  let sum = 0;
  for (let i = 0; i < 9; i++) {
    const digit = Number(v[i]);
    const tmp = (digit + (10 - (i + 1))) % 10;
    if (tmp === 0) continue;
    let p = (tmp * 2 ** (10 - (i + 1))) % 9;
    if (p === 0) p = 9;
    sum += p;
  }
  const check = (10 - (sum % 10)) % 10;
  return check === Number(v[9]);
}

/** TC Kimlik Numarası (11 hane) checksum'ı. */
export function isValidTckn(input: string): boolean {
  const v = digitsOnly(input);
  if (v.length !== 11) return false;
  if (v[0] === "0") return false;
  if (/^(\d)\1{10}$/.test(v)) return false;

  const d = [...v].map(Number) as number[];
  const odd = d[0]! + d[2]! + d[4]! + d[6]! + d[8]!;
  const even = d[1]! + d[3]! + d[5]! + d[7]!;
  const tenth = (odd * 7 - even) % 10;
  if (((tenth % 10) + 10) % 10 !== d[9]) return false;

  const firstTen = d.slice(0, 10).reduce((a, b) => a + b, 0);
  return firstTen % 10 === d[10];
}

/**
 * Serbest metinden vergi/kimlik numarası ayrıştırır ve doğrular.
 * Geçersizse `valid: false` döner — çağıran deterministik eşleşme için
 * kullanmamalıdır.
 */
export function parseTaxId(input: string): ParsedTaxId | null {
  const v = digitsOnly(input);
  if (v.length === 10) return { kind: "vkn", value: v, valid: isValidVkn(v) };
  if (v.length === 11) return { kind: "tckn", value: v, valid: isValidTckn(v) };
  // EU VAT: ülke kodu + rakamlar. Checksum ülkeye göre değişir; burada
  // yalnızca biçim doğrulanır ve `valid` işareti muhafazakâr bırakılır.
  const vat = input.trim().toUpperCase().replace(/\s/g, "");
  if (/^[A-Z]{2}[A-Z0-9]{8,12}$/.test(vat)) {
    return { kind: "vat", value: vat, valid: false };
  }
  return null;
}
