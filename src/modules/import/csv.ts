/**
 * CSV okuyucu — Türkiye'deki Excel gerçeğine göre.
 *
 * Bir kütüphane yerine bunu yazmanın sebebi, Türkçe Excel çıktısının
 * standart CSV varsayımlarını üç yerden kırmasıdır ve bu kırılmalar hazır
 * ayrıştırıcılarda sessiz veri bozulmasına yol açar:
 *
 *  1. AYIRICI NOKTALI VİRGÜLDÜR. Türkçe Windows'ta ondalık ayırıcı virgül
 *     olduğu için Excel, CSV alan ayırıcısını `;` yapar. Virgül varsayan bir
 *     okuyucu "1.234,56" değerini iki hücreye böler ve tutar bozulur.
 *
 *  2. DOSYA BOM İLE BAŞLAR. Excel UTF-8'i BOM ile yazar. Temizlenmezse ilk
 *     sütun başlığı "﻿Unvan" olur, hiçbir eşlemeye uymaz ve kullanıcı
 *     "ilk sütunu neden görmüyor" diye sorar.
 *
 *  3. SAYI VE TARİH BİÇİMİ FARKLIDIR. "1.234,56" bin ayırıcısı noktadır;
 *     `Number()` bunu NaN yapar. Tarih "31.12.2026" biçimindedir.
 *
 * AYIRICI TAHMİN EDİLİR, VARSAYILMAZ: başlık satırında hangi aday daha çok
 * geçiyorsa o seçilir. Yanlış tahmin tek sütunluk bir tabloyla sonuçlanır ve
 * bu, sessizce bozulmuş bir tablodan çok daha görünürdür.
 */

export interface CsvTable {
  readonly headers: readonly string[];
  readonly rows: readonly (readonly string[])[];
  readonly delimiter: string;
}

const CANDIDATE_DELIMITERS = [";", ",", "\t", "|"] as const;

/** Baştaki BOM'u atar. */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Ayırıcıyı ilk satırdan tahmin eder.
 *
 * Tırnak içindeki ayırıcılar SAYILMAZ: "Burçelik A.Ş., Bursa" tek bir
 * hücredir ve içindeki virgül ayırıcı sanılırsa tahmin tamamen şaşar.
 */
export function detectDelimiter(firstLine: string): string {
  let best = ";";
  let bestCount = 0;
  for (const d of CANDIDATE_DELIMITERS) {
    let count = 0;
    let inQuotes = false;
    for (let i = 0; i < firstLine.length; i++) {
      const ch = firstLine[i];
      if (ch === '"') {
        inQuotes = !inQuotes;
        continue;
      }
      if (!inQuotes && ch === d) count++;
    }
    if (count > bestCount) {
      best = d;
      bestCount = count;
    }
  }
  return best;
}

/**
 * RFC 4180 uyumlu ayrıştırma.
 *
 * Tırnak içindeki satır sonları KORUNUR — bir adres alanı iki satıra
 * yayılabilir ve satır satır okuyan bir ayrıştırıcı tabloyu kaydırır.
 */
export function parseCsv(input: string, forcedDelimiter?: string): CsvTable {
  const text = stripBom(input).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const firstLineEnd = text.indexOf("\n");
  const firstLine = firstLineEnd === -1 ? text : text.slice(0, firstLineEnd);
  const delimiter = forcedDelimiter ?? detectDelimiter(firstLine);

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;

    if (inQuotes) {
      if (ch === '"') {
        // İki tırnak = kaçırılmış tırnak karakteri.
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"' && field === "") {
      inQuotes = true;
      continue;
    }
    if (ch === delimiter) {
      row.push(field);
      field = "";
      continue;
    }
    if (ch === "\n") {
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
      continue;
    }
    field += ch;
  }

  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  // Tamamen boş satırlar atılır: Excel dosyalarının sonunda hep bulunur ve
  // "3 satır içe aktarıldı, 1'i boş" gibi anlamsız raporlar üretir.
  const cleaned = rows
    .map((r) => r.map((c) => c.trim()))
    .filter((r) => r.some((c) => c !== ""));

  const [headers = [], ...body] = cleaned;
  return { headers, rows: body, delimiter };
}

/**
 * Türkçe biçimli sayı.
 *
 * "1.234,56" → 1234.56 · "1234,56" → 1234.56 · "1234.56" → 1234.56
 *
 * BELİRSİZ DURUM SESSİZCE TAHMİN EDİLMEZ: "1.234" hem bin ayırıcılı 1234
 * hem ondalıklı 1.234 olabilir. Türkçe bağlamda nokta bin ayırıcısıdır ve
 * öyle yorumlanır; ama bu karar burada YAZILI, kodun içinde gizli değil.
 */
export function parseTurkishNumber(input: string): number | null {
  const raw = input.trim().replace(/\s/g, "");
  if (raw === "") return null;

  const hasComma = raw.includes(",");
  const hasDot = raw.includes(".");

  let normalized: string;
  if (hasComma && hasDot) {
    // Son gelen ayırıcı ondalıktır: "1.234,56" veya "1,234.56"
    normalized =
      raw.lastIndexOf(",") > raw.lastIndexOf(".")
        ? raw.replace(/\./g, "").replace(",", ".")
        : raw.replace(/,/g, "");
  } else if (hasComma) {
    normalized = raw.replace(",", ".");
  } else if (hasDot) {
    // Türkçe bağlamda nokta bin ayırıcısıdır: "1.234" → 1234.
    // Ama "1.5" gibi tek haneli kuyruk bin ayırıcısı olamaz.
    const parts = raw.split(".");
    const tail = parts[parts.length - 1]!;
    normalized = parts.length > 1 && tail.length === 3 ? raw.replace(/\./g, "") : raw;
  } else {
    normalized = raw;
  }

  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

/**
 * Türkçe biçimli tarih → ISO gün.
 *
 * "31.12.2026" · "31/12/2026" · "2026-12-31" kabul edilir.
 * AY/GÜN SIRASI TAHMİN EDİLMEZ: nokta ve eğik çizgi biçimlerinde ilk sayı
 * GÜNDÜR. "03.04.2026" ABD biçiminde 3 Nisan, Türkçe biçimde 3 Nisan'dır —
 * ama "13.04.2026" ancak Türkçe okunabilir. Karışık bir dosyada sessizce
 * ay/gün takası yapmak, teslim tarihlerini aylarca kaydırır.
 */
export function parseTurkishDate(input: string): string | null {
  const raw = input.trim();
  if (raw === "") return null;

  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (iso) return validDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const tr = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/.exec(raw);
  if (tr) return validDate(Number(tr[3]), Number(tr[2]), Number(tr[1]));

  return null;
}

function validDate(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  // 31 Şubat gibi taşan tarihler Date tarafından kaydırılır; yakala.
  if (date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return date.toISOString().slice(0, 10);
}

/** Satırları başlık adlarıyla eşleyip nesneye çevirir. */
export function toRecords(table: CsvTable): readonly Record<string, string>[] {
  return table.rows.map((row) => {
    const record: Record<string, string> = {};
    table.headers.forEach((h, i) => {
      record[h] = row[i] ?? "";
    });
    return record;
  });
}
