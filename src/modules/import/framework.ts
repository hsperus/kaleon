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
 * İKİ GEÇİŞ, ALAN BAZINDA DEĞİL DOSYA BAZINDA. Önce BÜTÜN alanlar için tam
 * eşleşme aranır, sonra kalanlar için içerme. Tek geçişte yapılsaydı sırada
 * önce gelen alan, sonraki bir alanın TAM eşleşmesini içermeyle kapardı:
 * "Tedarik Süresi" başlığı, "tedarik" takma adı yüzünden tedarik türüne
 * gider ve 21 günlük temin süresi sessizce kaybolurdu.
 *
 * İçerme geçişinde EN DAR uyan başlık seçilir: "Tutar" ve "Tutar (TL)"
 * birlikteyken, takma adı başlığın ne kadarını kapladığına bakılır; böylece
 * "Tutar" alanı "Tutar (TL)" başlığını kapıp gerçek "Tutar" sütununu
 * boşta bırakmaz.
 */
export function mapColumns(
  headers: readonly string[],
  fields: readonly FieldSpec[],
): Readonly<Record<string, string | null>> {
  const folded = headers.map((raw) => ({ raw, key: foldHeader(raw) }));
  const used = new Set<string>();
  const out: Record<string, string | null> = {};
  const aliasesOf = new Map<string, string[]>();

  for (const field of fields) {
    aliasesOf.set(field.key, field.aliases.map(foldHeader));
    out[field.key] = null;
  }

  // 1. geçiş — tam eşleşme. Kesin bilgi, tahmine karşı önceliklidir.
  for (const field of fields) {
    const aliases = aliasesOf.get(field.key)!;
    const hit = folded.find((h) => !used.has(h.raw) && aliases.includes(h.key));
    if (hit) {
      used.add(hit.raw);
      out[field.key] = hit.raw;
    }
  }

  // 2. geçiş — içerme, en dar uyandan başlayarak.
  for (const field of fields) {
    if (out[field.key] !== null) continue;
    const aliases = aliasesOf.get(field.key)!;
    let best: { raw: string; fit: number } | null = null;
    for (const h of folded) {
      if (used.has(h.raw)) continue;
      for (const a of aliases) {
        if (!h.key.includes(a)) continue;
        // Takma ad başlığın ne kadarını kaplıyor: 1'e yakın = dar uyum.
        const fit = a.length / h.key.length;
        if (!best || fit > best.fit) best = { raw: h.raw, fit };
      }
    }
    if (best) {
      used.add(best.raw);
      out[field.key] = best.raw;
    }
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
