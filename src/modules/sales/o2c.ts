/**
 * Sipariş → Sevkiyat → Fatura zinciri (Order-to-Cash) iş kuralları.
 *
 * SAP'nin belge akışı (VA01 → VL01N → VF01) doğru bir modeldir ve KAELON
 * aynı zinciri kurar. Zincirin değeri şudur: HER BELGE BİR ÖNCEKİNE
 * DAYANIR. Faturayı siparişten değil SEVKİYATTAN kesmek, "gitmemiş malın
 * faturası" hatasını yapısal olarak imkânsız kılar — bir kontrol kuralı
 * değil, veri modelinin sonucudur.
 *
 * ÜÇ MİKTAR AYRI TUTULUR:
 *   sipariş miktarı   — müşterinin istediği
 *   sevk edilen       — depodan gerçekten çıkan
 *   faturalanan       — müşteriye borç yazılan
 * Tek bir "durum" alanına sıkıştırılsaydı, kısmi sevkiyatta kalan miktar
 * kaybolurdu; kısmi sevkiyat imalatta istisna değil kuraldır.
 *
 * KAELON'UN SAP'DEN FARKI: aşırı sevkiyat toleransı SİPARİŞTE tanımlıdır
 * ve varsayılanı SIFIRDIR. SAP'de bu bir müşteri ana verisi ayarıdır ve
 * çoğu kurulumda kimse bakmaz; sessiz %10 tolerans, sözleşme dışı sevkiyatı
 * onaysız geçirir.
 */

export class DocumentFlowError extends Error {
  readonly code = "document_flow";
  constructor(message: string) {
    super(message);
    this.name = "DocumentFlowError";
  }
}

/** Sipariş kaleminin miktar durumu. */
export interface LineProgress {
  readonly lineNo: number;
  readonly itemCode: string;
  readonly uom: string;
  readonly orderedQty: number;
  readonly deliveredQty: number;
  readonly invoicedQty: number;
  /** Aşırı sevkiyat toleransı, yüzde. Varsayılan 0. */
  readonly overDeliveryTolerance?: number;
}

/** Bir kalemden daha ne kadar sevk edilebilir. */
export function deliverableQty(line: LineProgress): number {
  const tolerance = line.overDeliveryTolerance ?? 0;
  const ceiling = line.orderedQty * (1 + tolerance / 100);
  return Math.max(0, ceiling - line.deliveredQty);
}

/** Bir kalemden daha ne kadar faturalanabilir — SEVK EDİLEN esas alınır. */
export function invoiceableQty(line: LineProgress): number {
  return Math.max(0, line.deliveredQty - line.invoicedQty);
}

/**
 * Sevkiyat miktarını doğrular.
 *
 * MESAJ SAYIYI İÇERİR. "Aşırı sevkiyat" demek kullanıcıya hiçbir şey
 * anlatmaz; kaç adet sipariş edildiği, kaçının gittiği ve kaçının
 * kaldığı yazılırsa depocu kendi hatasını kendisi bulur.
 */
export function assertDeliverable(line: LineProgress, quantity: number): void {
  if (!(quantity > 0)) {
    throw new DocumentFlowError(`Sevk miktarı sıfırdan büyük olmalıdır (kalem ${line.lineNo}).`);
  }
  const remaining = deliverableQty(line);
  if (quantity > remaining + 1e-9) {
    const tolerance = line.overDeliveryTolerance ?? 0;
    throw new DocumentFlowError(
      `Kalem ${line.lineNo} (${line.itemCode}): sipariş ${line.orderedQty} ${line.uom}, ` +
        `sevk edilen ${line.deliveredQty} ${line.uom}, kalan ${round4(remaining)} ${line.uom}. ` +
        `${quantity} ${line.uom} sevk edilemez` +
        (tolerance > 0 ? ` (aşırı sevkiyat toleransı %${tolerance}).` : "; aşırı sevkiyat kapalı.") ,
    );
  }
}

/**
 * Fatura miktarını doğrular.
 *
 * SEVK EDİLMEMİŞ MAL FATURALANAMAZ. Bu kural yalnızca muhasebe düzeni
 * değil, vergi meselesidir: teslim edilmemiş mal için düzenlenen fatura
 * KDV'yi erken doğurur ve düzeltilmesi beyanname düzeltmesi gerektirir.
 */
export function assertInvoiceable(line: LineProgress, quantity: number): void {
  if (!(quantity > 0)) {
    throw new DocumentFlowError(`Fatura miktarı sıfırdan büyük olmalıdır (kalem ${line.lineNo}).`);
  }
  const remaining = invoiceableQty(line);
  if (quantity > remaining + 1e-9) {
    throw new DocumentFlowError(
      `Kalem ${line.lineNo} (${line.itemCode}): sevk edilen ${line.deliveredQty} ${line.uom}, ` +
        `faturalanan ${line.invoicedQty} ${line.uom}, faturalanabilir ${round4(remaining)} ${line.uom}. ` +
        `Sevk edilmemiş mal faturalanamaz.`,
    );
  }
}

export const ORDER_STATUSES = [
  "open",
  "partially_delivered",
  "delivered",
  "partially_invoiced",
  "completed",
  "cancelled",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/**
 * Sipariş durumunu kalemlerden TÜRETİR — elle yazılmaz.
 *
 * Durum ayrı bir alan olarak elle güncellenseydi, kalemlerle durum
 * arasında er ya da geç bir tutarsızlık oluşurdu ("tamamlandı" görünen
 * ama 200 adedi sevk edilmemiş sipariş). Miktarlar tek gerçektir;
 * durum onların bir görünümüdür.
 */
export function deriveOrderStatus(
  lines: readonly LineProgress[],
  cancelled = false,
): OrderStatus {
  if (cancelled) return "cancelled";
  if (lines.length === 0) return "open";

  const fullyDelivered = lines.every((l) => l.deliveredQty >= l.orderedQty - 1e-9);
  const anyDelivered = lines.some((l) => l.deliveredQty > 1e-9);
  const fullyInvoiced = lines.every((l) => l.invoicedQty >= l.deliveredQty - 1e-9);
  const anyInvoiced = lines.some((l) => l.invoicedQty > 1e-9);

  if (fullyDelivered && anyInvoiced && fullyInvoiced) return "completed";
  if (anyInvoiced) return "partially_invoiced";
  if (fullyDelivered) return "delivered";
  if (anyDelivered) return "partially_delivered";
  return "open";
}

/** Sipariş tümüyle kapanabilir mi — kapanmışsa yeni belge üretilmez. */
export function isClosed(status: OrderStatus): boolean {
  return status === "completed" || status === "cancelled";
}

/**
 * Belgeyi iptal edilebilir mi.
 *
 * FATURALANMIŞ SEVKİYAT İPTAL EDİLEMEZ. İptal edilseydi fatura, arkasında
 * hiçbir teslimat kaydı olmayan bir belge hâline gelir ve zincir kopardı.
 * Doğru yol önce iade faturası kesmektir.
 */
export function assertDeliveryCancellable(invoicedQty: number): void {
  if (invoicedQty > 1e-9) {
    throw new DocumentFlowError(
      "Faturalanmış sevkiyat iptal edilemez. Önce iade faturası düzenlenmelidir; " +
        "aksi hâlde fatura dayanaksız kalır.",
    );
  }
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
