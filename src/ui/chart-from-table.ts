/**
 * Tablodan grafik çıkarma.
 *
 * HER TABLO GRAFİĞE DÖNMEZ ve zorlananı yalan söyler. Üç tuzak var:
 *
 *  1. ARA TOPLAM SATIRI. "TRY Toplam" satırı, kendi parçalarıyla yan
 *     yana çizilirse grafikte iki kat yüksek bir çubuk çıkar ve
 *     bakan kişi onu bir kalem sanır.
 *
 *  2. KARIŞIK BİRİM. TL ve EUR satırları tek eksende çizilirse 411.200
 *     EUR, 12.400.000 TL'nin yanında "küçük" görünür — oysa daha
 *     büyüktür.
 *
 *  3. ANLAMSIZ SÜTUN. Sipariş numarası, vergi numarası ya da yıl
 *     sayısal görünür ama toplanmaz, karşılaştırılmaz.
 *
 * Bu modül grafik ÜRETMEZ, üretilebilir mi ona karar verir — ve
 * üretilemiyorsa SEBEBİNİ döndürür. Sessizce boş bir kutu göstermek,
 * kullanıcıya "grafik yok" değil "sistem bozuk" dedirtir.
 */

import type { Block } from "./markdown.js";
import type { Point } from "./chart.js";

type Table = Extract<Block, { kind: "table" }>;

export interface ChartSpec {
  readonly kind: "bar" | "line" | "donut";
  readonly title: string;
  readonly points: readonly Point[];
  readonly unit: string | null;
  /** Grafiğe alınmayan satırlar — kullanıcıya söylenir. */
  readonly excluded: readonly string[];
}

export type ChartPlan =
  | { readonly ok: true; readonly specs: readonly ChartSpec[] }
  | { readonly ok: false; readonly reason: string };

const TOTAL_WORDS = ["toplam", "total", "genel", "ara toplam", "cari toplam", "sum"];

/** Satır bir ara toplam mı — grafikte parçalarıyla yarışmamalı. */
export function isTotalRow(cells: readonly string[]): boolean {
  const first = (cells[0] ?? "").replace(/\*\*/g, "").trim().toLocaleLowerCase("tr");
  if (!first) return false;
  return TOTAL_WORDS.some((w) => first === w || first.startsWith(`${w} `) || first.endsWith(` ${w}`));
}

/** Kimlik gibi duran sütun — sayısal ama ölçü değil. */
const ID_HEADERS = [
  "no",
  "numara",
  "kod",
  "vkn",
  "tckn",
  "yıl",
  "ay",
  "sıra",
  "id",
  "kimlik",
  "hesap",
  "fatura no",
  "sipariş no",
];

export function looksLikeIdentifier(header: string): boolean {
  const h = header.replace(/\*\*/g, "").trim().toLocaleLowerCase("tr");
  return ID_HEADERS.some((k) => h === k || h.endsWith(` ${k}`) || h.startsWith(`${k} `));
}

const MONTHS = [
  "ocak", "şubat", "mart", "nisan", "mayıs", "haziran",
  "temmuz", "ağustos", "eylül", "ekim", "kasım", "aralık",
];

/** Etiketler zaman serisi mi — öyleyse çizgi grafik doğru olandır. */
export function looksLikeTimeSeries(labels: readonly string[]): boolean {
  if (labels.length < 3) return false;
  const hits = labels.filter((l) => {
    const t = l.trim().toLocaleLowerCase("tr");
    if (MONTHS.some((m) => t.includes(m))) return true;
    // 2026-01, 01/2026, 15.03.2026, 2026 Q1
    return /^\d{4}[-/]\d{1,2}$/.test(t) || /^\d{1,2}[./]\d{4}$/.test(t) ||
      /^\d{1,2}[./]\d{1,2}[./]\d{2,4}$/.test(t) || /^\d{4}\s*[çq][1-4]$/.test(t);
  });
  return hits.length >= labels.length * 0.7;
}

/**
 * Tanınan birim ve para birimi kodları.
 *
 * Bu liste dar tutuluyor: "Şehir" sütununu birim sanıp grafiği
 * şehirlere bölmek, karışık birim çizmek kadar yanlış olurdu.
 */
const UNIT_CODES = new Set([
  "TL", "TRY", "USD", "EUR", "GBP", "₺", "$", "€",
  "ADET", "KG", "TON", "LT", "M", "M2", "M3", "SAAT", "GÜN", "%",
]);

/**
 * Birim/para birimi sütunu.
 *
 * GERÇEK BİR CEVAPTA YAKALANDI: banka bakiyeleri tablosunda para
 * birimi ayrı bir sütundaydı ("Banka | Para Birimi | Kullanılabilir")
 * ve hücrede birim yazmadığı için planlayıcı 12.400.000 TL ile
 * 198.400 EUR'yu aynı eksende çiziyordu. EUR satırı grafikte "küçük"
 * görünüyordu — oysa daha büyüktü. Böyle bir sütun bulunursa grafik
 * BÖLÜNÜR, her para birimi kendi grafiğini alır.
 */
export function findUnitColumn(
  head: readonly string[],
  rows: readonly (readonly string[])[],
  numeric: readonly boolean[],
  labelCol: number,
): number | null {
  for (let c = 0; c < head.length; c += 1) {
    if (c === labelCol || numeric[c]) continue;
    const values = rows.map((r) => (r[c] ?? "").replace(/\*\*/g, "").trim().toLocaleUpperCase("tr"));
    if (values.some((v) => v === "")) continue;
    // Sütunun TAMAMI tanınan bir kod olmalı; biri bile değilse bu
    // sütun birim sütunu değildir.
    if (values.every((v) => UNIT_CODES.has(v))) return c;
  }
  return null;
}

/** Hücreden birim çıkarır: "156.000 TL" → "TL". */
export function unitOf(cell: string): string | null {
  const m = /(TL|TRY|USD|EUR|₺|\$|€|%|adet|kg|saat|gün)\s*$/i.exec(cell.trim());
  return m ? m[1]!.toLocaleUpperCase("tr") : null;
}

/** Türkçe biçimli metni sayıya çevirir; çevrilemezse null. */
export function toNumber(raw: string): number | null {
  const cleaned = raw
    .replace(/\*\*/g, "")
    .replace(/(TL|TRY|USD|EUR|₺|\$|€|%|adet|kg|saat|gün)/gi, "")
    .replace(/\s/g, "")
    .trim();
  if (!cleaned || !/^[-+]?[\d.,]+$/.test(cleaned)) return null;
  const n = Number(cleaned.replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/**
 * Tablodan çizilebilir grafik planı çıkarır.
 *
 * Her sayısal sütun AYRI bir grafiktir: net tutar ile KDV'yi tek
 * eksende çizmek teknik olarak mümkün ama okumayı zorlaştırır ve iki
 * ayrı soruyu tek resme sıkıştırır.
 */
export function planFrom(table: Table, title: string): ChartPlan {
  const head = table.head.map((h) => h.replace(/\*\*/g, "").trim());

  // Etiket sütunu: ilk sayısal OLMAYAN sütun.
  const labelCol = table.numeric.findIndex((n) => !n);
  if (labelCol === -1) return { ok: false, reason: "Tabloda etiket sütunu yok; her sütun sayısal." };

  const valueCols = head
    .map((h, i) => ({ h, i }))
    .filter(({ h, i }) => i !== labelCol && table.numeric[i] && !looksLikeIdentifier(h));

  if (valueCols.length === 0) {
    return {
      ok: false,
      reason: "Tabloda ölçülebilir sayısal sütun yok; numara ve kod alanları grafiğe girmez.",
    };
  }

  const body = table.rows.filter((r) => !isTotalRow(r));
  const excluded = table.rows.filter((r) => isTotalRow(r)).map((r) => (r[labelCol] ?? "").replace(/\*\*/g, ""));

  if (body.length === 0) return { ok: false, reason: "Grafiğe girecek satır kalmadı." };
  if (body.length > 40) {
    return { ok: false, reason: `${body.length} satır bir grafiğe sığmaz; önce daralt.` };
  }

  // Birim sütunu varsa tablo gruplara bölünür; her grup kendi
  // grafiğini alır ve hiçbir eksende iki birim buluşmaz.
  const unitCol = findUnitColumn(head, body, table.numeric, labelCol);
  if (unitCol !== null) {
    const groups = new Map<string, (readonly string[])[]>();
    for (const r of body) {
      const key = (r[unitCol] ?? "").replace(/\*\*/g, "").trim().toLocaleUpperCase("tr");
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(r);
    }
    if (groups.size > 1) {
      const all: ChartSpec[] = [];
      for (const [unit, rows] of groups) {
        const sub = planFrom(
          {
            ...table,
            // Birim sütunu çıkarılır: artık her grup tek birimli.
            head: head.filter((_, c) => c !== unitCol),
            rows: rows.map((r) => r.filter((_, c) => c !== unitCol)),
            numeric: table.numeric.filter((_, c) => c !== unitCol),
          },
          `${title} — ${unit}`,
        );
        if (sub.ok) all.push(...sub.specs);
      }
      return all.length > 0
        ? { ok: true, specs: all }
        : { ok: false, reason: "Birim gruplarının hiçbiri grafiğe uygun değil." };
    }
  }

  const labels = body.map((r) => (r[labelCol] ?? "").replace(/\*\*/g, "").trim());
  const timeSeries = looksLikeTimeSeries(labels);

  const specs: ChartSpec[] = [];
  for (const { h, i } of valueCols) {
    const cells = body.map((r) => r[i] ?? "");
    const units = cells.map(unitOf).filter((u): u is string => u !== null);
    const distinct = new Set(units);

    // KARIŞIK BİRİM ÇİZİLMEZ. Bu sütun atlanır; diğerleri çizilebilir.
    if (distinct.size > 1) continue;

    const points: Point[] = body.map((r, k) => ({
      label: labels[k]!,
      value: toNumber(r[i] ?? ""),
    }));

    // Hiç bilinen değer yoksa grafik boş bir kutu olurdu.
    if (points.every((pt) => pt.value === null)) continue;

    // TAMAMI SIFIR OLAN SÜTUN ÇİZİLMEZ. Gerçek bir cevapta "Blokeli"
    // sütunu bütün satırlarda sıfırdı ve ekranı boş bir eksen
    // kaplıyordu: karşılaştırılacak hiçbir şey yok. Sıfırlar tablonun
    // kendisinde zaten görünüyor, o yüzden ayrıca söylenmiyor —
    // hiçbir sütun kalmazsa sebep aşağıda yazılır.
    if (points.every((pt) => pt.value === null || pt.value === 0)) continue;

    const unit = distinct.size === 1 ? [...distinct][0]! : null;
    const values = points.map((pt) => pt.value).filter((v): v is number => v !== null);
    const allPositive = values.every((v) => v >= 0);

    // Pay grafiği yalnızca "bütünün parçaları" içindir: az satır, hepsi
    // pozitif ve zaman serisi değil.
    const kind: ChartSpec["kind"] = timeSeries
      ? "line"
      : allPositive && body.length >= 2 && body.length <= 6 && valueCols.length === 1
        ? "donut"
        : "bar";

    specs.push({
      kind,
      title: valueCols.length === 1 ? title : `${title} — ${h}`,
      points,
      unit,
      excluded,
    });
  }

  if (specs.length === 0) {
    const allZero = valueCols.every(({ i }) =>
      body.every((r) => {
        const v = toNumber(r[i] ?? "");
        return v === null || v === 0;
      }),
    );
    return {
      ok: false,
      reason: allZero
        ? "Sayısal sütunların tamamı sıfır; karşılaştırılacak bir şey yok."
        : "Sayısal sütunlar tek bir eksende karşılaştırılamıyor: farklı para birimleri ya da " +
          "birimler aynı sütunda karışmış.",
    };
  }

  return { ok: true, specs };
}
