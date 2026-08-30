/**
 * Stok sayımı.
 *
 * SAYIM, SİSTEMİN GERÇEKLE YÜZLEŞTİĞİ TEK ANDIR. Diğer her şey kayıttan
 * kayda gider; sayım, kaydın dışına çıkıp mala bakar. Bu yüzden sayımın
 * kalitesi tüm stok değerlemesinin kalitesidir.
 *
 * KÖR SAYIM VARSAYILANDIR. Sayan kişiye sistemdeki miktar gösterilirse,
 * yorgun bir vardiyanın sonunda o sayı kopyalanır ve sayım hiçbir şey
 * bulmaz — üstelik "saydık, tuttu" denir ve fark aylarca gizlenir. SAP'de
 * kör sayım bir ayardır ve çoğu kurulumda kapalıdır; burada AÇIK gelir.
 *
 * SİSTEM MİKTARI SAYIM BAŞLARKEN DONDURULUR. Dondurulmasaydı, sayım
 * sürerken yapılan bir sevkiyat farkı kendiliğinden yaratırdı: depocu
 * doğru saymış olur ama sistem onu hatalı gösterirdi.
 *
 * FARK OTOMATİK KABUL EDİLMEZ. Büyük farklar tekrar sayım ister; ilk
 * sayımı doğru kabul etmek, bir yazım hatasını kalıcı bir stok
 * düzeltmesine çevirir.
 */

export const COUNT_STATUSES = ["open", "counted", "posted", "cancelled"] as const;
export type CountStatus = (typeof COUNT_STATUSES)[number];

export class StockCountError extends Error {
  readonly code = "stock_count";
  constructor(message: string) {
    super(message);
    this.name = "StockCountError";
  }
}

/**
 * Tekrar sayım eşiği.
 *
 * Bu oranın üstündeki fark, kaydedilmeden önce ikinci bir sayım ister.
 * Eşiksiz bir sistemde 1000 yerine 100 yazılması, 900 birimlik bir
 * "kayıp" olarak muhasebeleşir ve geri alınması ayrı bir düzeltme gerektirir.
 */
export const RECOUNT_THRESHOLD_PERCENT = 10;
/** Küçük miktarlarda oran anlamsızdır; mutlak eşik de gerekir. */
export const RECOUNT_THRESHOLD_ABSOLUTE = 5;

export interface CountLine {
  readonly lineNo: number;
  readonly itemCode: string;
  readonly batchId: string | null;
  /** Sayım BAŞLARKEN dondurulmuş sistem miktarı. */
  readonly systemQty: number;
  /** Sayılan miktar. Henüz sayılmadıysa null — sıfır DEĞİL. */
  readonly countedQty: number | null;
  readonly unitCost: number | null;
}

export interface CountDifference {
  readonly lineNo: number;
  readonly itemCode: string;
  readonly systemQty: number;
  readonly countedQty: number;
  readonly difference: number;
  readonly differencePercent: number | null;
  readonly valueDifference: number | null;
  readonly needsRecount: boolean;
}

/**
 * Fark hesabı.
 *
 * SAYILMAYAN KALEM SIFIR SAYILMAZ. Sıfır sayılsaydı, sayılmamış her kalem
 * tam kayıp olarak yazılır ve tek bir eksik satır envanteri silerdi.
 */
export function differenceOf(line: CountLine): CountDifference | null {
  if (line.countedQty === null) return null;

  const difference = round4(line.countedQty - line.systemQty);
  const differencePercent =
    line.systemQty === 0 ? null : round2((difference / Math.abs(line.systemQty)) * 100);

  const needsRecount =
    Math.abs(difference) > RECOUNT_THRESHOLD_ABSOLUTE &&
    (differencePercent === null ||
      Math.abs(differencePercent) > RECOUNT_THRESHOLD_PERCENT);

  return {
    lineNo: line.lineNo,
    itemCode: line.itemCode,
    systemQty: line.systemQty,
    countedQty: line.countedQty,
    difference,
    differencePercent,
    // MALİYET BİLİNMİYORSA DEĞER FARKI DA BİLİNMEZ — sıfır değil.
    valueDifference: line.unitCost === null ? null : round2(difference * line.unitCost),
    needsRecount,
  };
}

export interface CountSummary {
  readonly countedLines: number;
  readonly uncountedLines: number;
  readonly differenceLines: number;
  readonly recountLines: readonly number[];
  /** Değeri bilinen farkların toplamı. */
  readonly netValueDifference: number;
  /** Maliyeti bilinmediği için toplama giremeyen kalem sayısı. */
  readonly unvaluedDifferences: number;
}

export function summarize(lines: readonly CountLine[]): CountSummary {
  let counted = 0;
  let uncounted = 0;
  let diffLines = 0;
  let net = 0;
  let unvalued = 0;
  const recount: number[] = [];

  for (const l of lines) {
    const d = differenceOf(l);
    if (!d) {
      uncounted += 1;
      continue;
    }
    counted += 1;
    if (d.difference !== 0) {
      diffLines += 1;
      if (d.valueDifference === null) unvalued += 1;
      else net += d.valueDifference;
    }
    if (d.needsRecount) recount.push(l.lineNo);
  }

  return {
    countedLines: counted,
    uncountedLines: uncounted,
    differenceLines: diffLines,
    recountLines: recount,
    netValueDifference: round2(net),
    unvaluedDifferences: unvalued,
  };
}

/**
 * Sayım kaydedilebilir mi.
 *
 * EKSİK SAYIM KAYDEDİLEMEZ. Kaydedilseydi, sayılmamış kalemler eski
 * miktarıyla kalır ama sayım "tamamlandı" görünürdü; bir sonraki sayıma
 * kadar kimse o kalemlere bakmazdı.
 */
export function assertPostable(
  lines: readonly CountLine[],
  status: CountStatus,
  opts: { allowRecountOverride?: boolean } = {},
): void {
  if (status === "posted") {
    throw new StockCountError("Bu sayım zaten kaydedilmiş.");
  }
  if (status === "cancelled") {
    throw new StockCountError("İptal edilmiş sayım kaydedilemez.");
  }

  const s = summarize(lines);
  if (s.uncountedLines > 0) {
    throw new StockCountError(
      `${s.uncountedLines} kalem henüz sayılmamış. Eksik sayım kaydedilirse o kalemler ` +
        `eski miktarıyla kalır ama sayım "tamamlandı" görünür.`,
    );
  }
  if (s.recountLines.length > 0 && !opts.allowRecountOverride) {
    throw new StockCountError(
      `${s.recountLines.join(", ")}. kalemlerde fark %${RECOUNT_THRESHOLD_PERCENT} eşiğini ` +
        `aşıyor; TEKRAR SAYIM gerekiyor. Bir yazım hatasını kalıcı stok düzeltmesine ` +
        `çevirmemek için ikinci sayım istenir.`,
    );
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
