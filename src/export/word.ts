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
import { legalFooter, type Letterhead } from "../modules/documents/letterhead.js";

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

/** Antet satırı — boş alan hiç yazılmaz, "—" ile doldurulmaz. */
function antetSatiri(parts: readonly (string | null)[]): string {
  const dolu = parts.filter((p): p is string => Boolean(p && p.trim()));
  return dolu.length === 0 ? "" : `<div class="org-line">${dolu.map(esc).join(" · ")}</div>`;
}

export function buildWord(
  title: string,
  sheets: readonly Sheet[],
  letterhead?: Letterhead | null,
): Buffer {
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
  /*
   * A4 DİKEY — HER ZAMAN.
   *
   * Yatay yazılmıştı çünkü geniş tablolar sığmıyordu. Ama bu belgeler
   * mali müşavire ve bankaya gidiyor; yatay bir A4 dosyalanırken ters
   * durur ve resmî bir yazışmada yabancı görünür. Genişlik sorunu
   * yönle değil PUNTOYLA çözülür: tablo yazısı bir kademe küçük.
   */
  @page { size: A4 portrait; margin: 1.8cm 1.6cm }
  body { font-family: Calibri, "Segoe UI", sans-serif; font-size: 10pt; color: #1a1a1a }
  h1 { font-size: 15pt; margin: 0 0 2pt; letter-spacing: -.2pt }
  h2 { font-size: 11.5pt; margin: 14pt 0 4pt }
  .org { font-size: 12pt; font-weight: bold; margin: 0 }
  .org-line { font-size: 8pt; color: #6b7178; margin: 1pt 0 0 }
  .rule { border-top: 1.5pt solid #16181c; margin: 8pt 0 0; height: 0 }
  .doctitle { font-size: 9.5pt; font-weight: bold; color: #3d434b; text-align: right }
  .stamp { font-size: 8pt; color: #6b7178; text-align: right }
  .foot { font-size: 7.5pt; color: #6b7178; border-top: 0.5pt solid #e2e4e8;
          margin-top: 14pt; padding-top: 6pt }
  .foot b { color: #3d434b }
  table { border-collapse: collapse; width: 100% }
  th, td { border: 0.5pt solid #b9b9b9; padding: 3.5pt 5pt; font-size: 8.5pt }
  th { background: #efefef; font-weight: bold }
</style>
</head>
<body>
${
  letterhead
    ? `<table style="width:100%;border:0"><tr>
  <td style="border:0;padding:0;vertical-align:top">
    <p class="org">${esc(letterhead.legalName)}</p>
    ${antetSatiri([letterhead.address])}
    ${antetSatiri([letterhead.phone, letterhead.email])}
    ${antetSatiri([
      letterhead.taxOffice && letterhead.taxId
        ? `${letterhead.taxOffice} V.D. ${letterhead.taxId}`
        : letterhead.taxId,
    ])}
  </td>
  <td style="border:0;padding:0;vertical-align:top">
    <p class="doctitle">${esc(title)}</p>
    <p class="stamp">${esc(new Date().toLocaleDateString("tr-TR"))}</p>
  </td>
</tr></table>
<div class="rule"></div>`
    : `<h1>${esc(title)}</h1>
<p class="stamp">${esc(new Date().toLocaleDateString("tr-TR"))}</p>`
}
${bolumler}
<div class="foot"><b>${esc(letterhead ? legalFooter(letterhead) : "")}</b>${
  letterhead ? " · " : ""
}${esc(new Date().toLocaleString("tr-TR"))} · Bu belge işletmenin kendi kayıtlarından üretilmiştir · KAELON</div>
</body>
</html>`;

  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(html, "utf8")]);
}
