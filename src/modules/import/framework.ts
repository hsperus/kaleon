/**
 * İçe aktarma çerçevesi.
 *
 * SAP'nin göç mantığı (LTMC) şudur: göç NESNESİNİ seç → şablonu indir →
 * doldur → yükle → SİMÜLE ET → hata listesini gör → kaydet. Bu akış doğru
 * ve KAELON da aynısını yapar. İki yerde daha ileri gidiyoruz:
 *
 *  1. NESNEYİ KULLANICI DEĞİL SİSTEM SEÇER. SAP'de önce "hangi göç
 *     nesnesi" diye sorulur; kullanıcı bilmek zorundadır. Burada dosyanın
 *     BAŞLIKLARINA bakıp ne olduğunu sistem anlar. Emin olamazsa sorar —
 *     ama tahmin edebiliyorken sormak, kullanıcıyı sistemin iç sözlüğünü
 *     öğrenmeye zorlamaktır.
 *
 *  2. HER NESNE BİR YETKİYE BAĞLIDIR. Puantaj dosyasını satın almacı
 *     yükleyemez, cari listesini İK yükleyemez. SAP'de bu yetkilendirme
 *     nesnesiyle yapılır; burada mevcut RBAC'e bağlanır ve yetkisi
 *     olmayan nesne kullanıcıya HİÇ ÖNERİLMEZ.
 *
 * ÜÇÜNCÜ İLKE HER NESNEDE AYNI: ÖNCE GÖSTER, SONRA YAZ. Tek adımlı bir
 * içe aktarma, 4000 satırın 900'ünü bozuk yazıp durur ve geri alınamaz.
 */

import type { Permission } from "../../kernel/types.js";
import { normalizeName } from "../master-data/normalize.js";
import { toRecords, type CsvTable } from "./csv.js";

/** Bir satırın reddedilme sebebi — satır numarasıyla. */
export interface RowError {
  /** Dosyadaki satır numarası. Başlık 1'dir, veri 2'den başlar. */
  readonly line: number;
  readonly field: string;
  readonly message: string;
}

export interface ParsedRows<T> {
  readonly valid: readonly T[];
  readonly errors: readonly RowError[];
}

/** Bir alanın dosyada hangi başlıklarla görünebileceği. */
export interface FieldSpec {
  readonly key: string;
  readonly label: string;
  readonly aliases: readonly string[];
  /** Bu alan yoksa dosya hiç işlenemez. */
  readonly required?: boolean;
}

export interface ImportObject<T> {
  readonly id: string;
  /** Kullanıcıya görünen ad: "Cari listesi", "Banka ekstresi"… */
  readonly label: string;
  /** Bu nesneyi içe aktarmak için gereken yetki. */
  readonly requires: Permission;
  readonly fields: readonly FieldSpec[];
  /** Satırları ayrıştırır ve doğrular. Yazma YAPMAZ. */
  parse(table: CsvTable, columns: Readonly<Record<string, string | null>>): ParsedRows<T>;
  /** Örnek şablon başlıkları — kullanıcı "nasıl bir dosya" diye sorunca. */
  readonly templateHeaders: readonly string[];
}

/** Başlık adını karşılaştırma için sadeleştirir (Türkçe duyarlı). */
export function foldHeader(h: string): string {
  return normalizeName(h).full;
}

/**
 * Başlıkları alanlara eşler.
 *
 * Önce TAM eşleşme, sonra içerme aranır: "Tutar" tam eşleşirken
 * "Tutar (TL)" ancak içermeyle bulunur. Ters sırada yapılsaydı "Tutar"
 * başlığı "Tutar (TL)" alanına da uyar ve yanlış sütun seçilebilirdi.
 */
export function mapColumns(
  headers: readonly string[],
  fields: readonly FieldSpec[],
): Readonly<Record<string, string | null>> {
  const folded = headers.map((raw) => ({ raw, key: foldHeader(raw) }));
  const used = new Set<string>();
  const out: Record<string, string | null> = {};

  for (const field of fields) {
    const aliases = field.aliases.map(foldHeader);
    const exact = folded.find((h) => !used.has(h.raw) && aliases.includes(h.key));
    const partial =
      exact ?? folded.find((h) => !used.has(h.raw) && aliases.some((a) => h.key.includes(a)));
    if (partial) used.add(partial.raw);
    out[field.key] = partial?.raw ?? null;
  }
  return out;
}

/** Bir nesnenin bu başlıklara ne kadar uyduğu: 0..1 */
export function matchScore(
  headers: readonly string[],
  object: ImportObject<unknown>,
): number {
  const cols = mapColumns(headers, object.fields);
  const required = object.fields.filter((f) => f.required);
  // Zorunlu alanlardan biri eksikse bu nesne OLAMAZ.
  if (required.some((f) => cols[f.key] === null)) return 0;

  const matched = object.fields.filter((f) => cols[f.key] !== null).length;
  return matched / object.fields.length;
}

export interface Detection {
  readonly object: ImportObject<unknown>;
  readonly score: number;
}

/**
 * Dosyanın hangi nesne olduğunu tahmin eder.
 *
 * BELİRSİZLİK SESSİZCE ÇÖZÜLMEZ. İki nesne birbirine yakın puan alıyorsa
 * ikisi de döner ve kullanıcıya sorulur. Yanlış nesneye aktarmak, veriyi
 * yanlış tabloya yazmak demektir; "en yüksek puanı seç" kuralı burada
 * ucuz bir kolaylık, pahalı bir hata olurdu.
 */
export const AMBIGUITY_MARGIN = 0.15;

export function detectObject(
  headers: readonly string[],
  objects: readonly ImportObject<unknown>[],
): readonly Detection[] {
  const scored = objects
    .map((object) => ({ object, score: matchScore(headers, object) }))
    .filter((d) => d.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return [];
  const best = scored[0]!;
  return scored.filter((d) => best.score - d.score <= AMBIGUITY_MARGIN);
}

/** Ortak yardımcı: satırları nesneye çevirip alan okumayı kolaylaştırır. */
export function rowReader(
  table: CsvTable,
  columns: Readonly<Record<string, string | null>>,
): readonly ((key: string) => string)[] {
  return toRecords(table).map((record) => (key: string) => {
    const header = columns[key];
    return header ? (record[header] ?? "").trim() : "";
  });
}
