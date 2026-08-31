/**
 * Word çıktısı.
 *
 * NEDEN OOXML DEĞİL: gerçek bir `.docx` üretmek zip paketi, birden çok
 * XML parçası ve ilişki dosyası demektir — ve bu üründe kazandıracağı
 * tek şey uzantı olurdu. Word, `application/msword` tipiyle gelen
 * HTML'i doğrudan açar, tabloyu biçimli gösterir ve kullanıcı
 * dosyayı `.docx` olarak kaydedebilir.
 *
 * BU BİR NUMARA DEĞİL, YERLEŞİK BİR YOL. Word bu biçimi yirmi yıldır
 * destekliyor ve Türkiye'de mali müşavirlerin kullandığı çoğu program
 * aynı yöntemi kullanıyor. Yine de ne olduğunu gizlemiyoruz: dosya
 * `.doc` uzantısıyla iner, `.docx` olduğunu iddia etmiyoruz.
 *
 * SAYILAR SAĞA YASLI KALIR. Excel'de bunu hücre tipi yapıyor; burada
 * yapan biz olmalıyız, yoksa tutar sütunu okunmaz hâle gelir.
 */

import type { Sheet } from "./xlsx.js";

/** HTML'e gömülen her metin kaçırılır — hücre içeriği kod değildir. */
function esc(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function bicimle(v: unknown): string {
  if (typeof v === "number") {
    return v.toLocaleString("tr-TR", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  }
  return esc(v);
}

export function buildWord(title: string, sheets: readonly Sheet[]): Buffer {
  const bolumler = sheets
    .map((s) => {
      const basliklar = s.columns
        .map((c) => `<th style="${c.format ? "text-align:right" : "text-align:left"}">${esc(c.header)}</th>`)
        .join("");

      const satirlar = s.rows
        .map((r) => {
          const hucreler = r
            .map((v, i) => {
              const sayisal = typeof v === "number" || s.columns[i]?.format !== undefined;
              return `<td style="${sayisal ? "text-align:right" : "text-align:left"}">${bicimle(v)}</td>`;
            })
            .join("");
          return `<tr>${hucreler}</tr>`;
        })
        .join("");

      return `<h2>${esc(s.name)}</h2>
<table>
  <thead><tr>${basliklar}</tr></thead>
  <tbody>${satirlar}</tbody>
</table>`;
    })
    .join("\n");

  /*
   * `charset=utf-8` VE BOM BİRLİKTE. Word yalnızca meta etiketine
   * bakmıyor; BOM'suz dosyada Türkçe karakterler bozuluyor ve "ş" ile
   * "ğ" kutuya dönüyor — müşteriye gönderilecek bir belgede kabul
   * edilemez.
   */
  const html = `<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office"
      xmlns:w="urn:schemas-microsoft-com:office:word"
      xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta charset="utf-8" />
<title>${esc(title)}</title>
<style>
  @page { size: A4 landscape; margin: 1.6cm }
  body { font-family: Calibri, "Segoe UI", sans-serif; font-size: 10pt; color: #1a1a1a }
  h1 { font-size: 16pt; margin: 0 0 4pt }
  h2 { font-size: 12pt; margin: 14pt 0 4pt }
  .stamp { font-size: 8.5pt; color: #666; margin: 0 0 10pt }
  table { border-collapse: collapse; width: 100% }
  th, td { border: 0.5pt solid #b9b9b9; padding: 4pt 6pt; font-size: 9.5pt }
  th { background: #efefef; font-weight: bold }
</style>
</head>
<body>
<h1>${esc(title)}</h1>
<p class="stamp">KAELON · ${new Date().toLocaleString("tr-TR")}</p>
${bolumler}
</body>
</html>`;

  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(html, "utf8")]);
}
