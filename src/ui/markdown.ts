/**
 * Cevap metni ayrıştırıcısı.
 *
 * REACT'TEN AYRI DURUYOR ÇÜNKÜ SAF MANTIK. Bileşenin içinde kalsaydı
 * tek bir senaryosu bile test edilemezdi; oysa buradaki hatalar
 * sessizdir: bir tablo yanlış ayrıştırılırsa ekranda boru işaretleriyle
 * dolu bir metin yığını çıkar ve kimse "ayrıştırıcı bozuk" demez,
 * "model kötü cevap verdi" der.
 *
 * HTML ÜRETİLMEZ. Ayrıştırıcı yalnızca yapı döndürür; render eden taraf
 * React elemanı kurar. Böylece model çıktısı hiçbir zaman markup olarak
 * yorumlanmaz ve enjeksiyon yüzeyi oluşmaz — hazır markdown
 * kütüphanelerinin çoğu HTML üretip `dangerouslySetInnerHTML` ile
 * bastırır ve o yol, model çıktısını doğrudan DOM'a taşır.
 */

export type InlineToken =
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "bold"; readonly value: string }
  | { readonly kind: "italic"; readonly value: string }
  | { readonly kind: "code"; readonly value: string };

/** Satır içi biçimler: **kalın**, *italik*, `kod`. */
export function parseInline(text: string): readonly InlineToken[] {
  const out: InlineToken[] = [];
  // KOD ÖNCE AYRILIR: `a * b` içindeki yıldız italik sayılmamalı.
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push({ kind: "text", value: text.slice(last, m.index) });
    const t = m[0];
    if (t.startsWith("`")) out.push({ kind: "code", value: t.slice(1, -1) });
    else if (t.startsWith("**")) out.push({ kind: "bold", value: t.slice(2, -2) });
    else out.push({ kind: "italic", value: t.slice(1, -1) });
    last = m.index + t.length;
  }
  if (last < text.length) out.push({ kind: "text", value: text.slice(last) });
  return out.length > 0 ? out : [{ kind: "text", value: text }];
}

export type Block =
  | { readonly kind: "paragraph"; readonly text: string }
  | { readonly kind: "heading"; readonly level: number; readonly text: string }
  | { readonly kind: "list"; readonly ordered: boolean; readonly items: readonly string[] }
  | { readonly kind: "quote"; readonly text: string }
  | { readonly kind: "code"; readonly text: string }
  | {
      readonly kind: "table";
      readonly head: readonly string[];
      readonly rows: readonly (readonly string[])[];
      /** Sütun sayısal mı — sayılar sağa yaslanır. */
      readonly numeric: readonly boolean[];
    };

const HEADING = /^(#{1,4})\s+(.*)$/;
const ORDERED = /^\s*\d+[.)]\s+/;
const BULLET = /^\s*[-*·•]\s+/;
const QUOTE = /^>\s?/;
const FENCE = /^```/;
const TABLE_SEP = /^\s*\|?[\s:-]*-[\s|:-]*\|?\s*$/;

function cells(line: string): string[] {
  return line
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((c) => c.trim());
}

/**
 * Sütun sayısal mı.
 *
 * Para birimi ve yüzde işareti taşıyan değerler de sayıdır: "156.000 TL"
 * sola yaslanırsa basamaklar hizalanmaz ve tablo karşılaştırma için
 * kullanılamaz hâle gelir — bir mizanın tek işi karşılaştırılabilir
 * olmaktır.
 */
export function isNumericValue(v: string): boolean {
  const t = v.trim();
  if (!/\d/.test(t)) return false;
  return /^[-+]?[\d.,\s]+(%|TL|USD|EUR|TRY|₺|\$|€|adet|kg|saat|gün)?$/i.test(t);
}

/** Metni bloklara ayırır. */
export function parseBlocks(text: string): readonly Block[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    if (!line.trim()) {
      i += 1;
      continue;
    }

    if (FENCE.test(line.trim())) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !FENCE.test(lines[i]!.trim())) {
        body.push(lines[i]!);
        i += 1;
      }
      i += 1;
      out.push({ kind: "code", text: body.join("\n") });
      continue;
    }

    const h = HEADING.exec(line);
    if (h) {
      out.push({ kind: "heading", level: h[1]!.length, text: h[2]!.trim() });
      i += 1;
      continue;
    }

    // TABLO: başlık satırı + ayraç satırı birlikte olmalı. Yalnızca boru
    // işareti aramak, "a|b" içeren normal bir cümleyi tabloya çevirirdi.
    if (line.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]!)) {
      const head = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim()) {
        const r = cells(lines[i]!);
        // Eksik hücre boş kalır, fazlası atılır: satır başlıkla uyuşmazsa
        // tablo kayar ve rakamlar yanlış sütuna düşer.
        rows.push(head.map((_, c) => r[c] ?? ""));
        i += 1;
      }
      const numeric = head.map((_, c) => rows.some((r) => isNumericValue(r[c] ?? "")));
      out.push({ kind: "table", head, rows, numeric });
      continue;
    }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i]!)) {
        body.push(lines[i]!.replace(QUOTE, ""));
        i += 1;
      }
      out.push({ kind: "quote", text: body.join(" ") });
      continue;
    }

    if (ORDERED.test(line)) {
      const items: string[] = [];
      while (i < lines.length && ORDERED.test(lines[i]!)) {
        items.push(lines[i]!.replace(ORDERED, ""));
        i += 1;
      }
      out.push({ kind: "list", ordered: true, items });
      continue;
    }

    if (BULLET.test(line)) {
      const items: string[] = [];
      while (i < lines.length && BULLET.test(lines[i]!)) {
        items.push(lines[i]!.replace(BULLET, ""));
        i += 1;
      }
      out.push({ kind: "list", ordered: false, items });
      continue;
    }

    const body: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() &&
      !HEADING.test(lines[i]!) &&
      !BULLET.test(lines[i]!) &&
      !ORDERED.test(lines[i]!) &&
      !QUOTE.test(lines[i]!) &&
      !FENCE.test(lines[i]!.trim())
    ) {
      body.push(lines[i]!);
      i += 1;
    }
    out.push({ kind: "paragraph", text: body.join(" ") });
  }

  return out;
}
