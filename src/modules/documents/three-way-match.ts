/**
 * Üç yönlü eşleştirme: Sipariş ↔ Mal Kabul ↔ Fatura.
 *
 * Satın alma tarafındaki en temel kontroldür ve klasik ERP'de en sık
 * gevşetilen yerdir: tolerans "geçici olarak" açılır, bir daha kapatılmaz,
 * ve tedarikçi fiyat farkları aylarca fark edilmeden ödenir.
 *
 * TOLERANS MANTIĞI (SAP'nin yaklaşımını izler ve nedeni önemlidir):
 * Bir sapma, HEM yüzde HEM mutlak eşiği aşıyorsa bloklanır.
 *   - 10 TL'lik bir kalemde %50 sapma = 5 TL. Yüzde büyük ama para küçük;
 *     bunu insana götürmek, insanın dikkatini çöple doldurur.
 *   - 10.000.000 TL'lik bir kalemde %0,5 sapma = 50.000 TL. Yüzde küçük ama
 *     para büyük; bu mutlaka görülmeli.
 * Tek eşik kullanmak bu iki durumdan birini kaçırır. İkisi birden gerekir.
 */

export interface PurchaseOrderLine {
  readonly poId: string;
  readonly lineNo: number;
  readonly itemId: string;
  readonly quantity: number;
  readonly unitPrice: number;
  readonly currency: string;
}

export interface GoodsReceiptLine {
  readonly grId: string;
  readonly poId: string;
  readonly poLineNo: number;
  readonly quantity: number;
  readonly receivedAt: string;
}

export interface InvoiceLine {
  readonly lineNo: number;
  readonly poId: string | null;
  readonly poLineNo: number | null;
  readonly itemId: string;
  readonly quantity: number;
  readonly unitPrice: number;
  readonly currency: string;
}

export interface Invoice {
  readonly id: string;
  readonly partnerId: string;
  readonly documentNo: string;
  readonly issuedAt: string;
  readonly currency: string;
  readonly lines: readonly InvoiceLine[];
}

export interface MatchTolerance {
  /** Yüzde eşiği — örn. 2 → %2. */
  readonly pricePercent: number;
  /** Mutlak eşik, fatura para biriminde. */
  readonly priceAbsolute: number;
  /** Miktar yüzde eşiği. Fazla faturalama için. */
  readonly quantityPercent: number;
}

export const DEFAULT_TOLERANCE: MatchTolerance = {
  pricePercent: 2,
  priceAbsolute: 500,
  quantityPercent: 0,
};

export type BlockReason =
  | "no_po_reference"
  | "po_line_not_found"
  | "no_goods_receipt"
  | "quantity_exceeds_receipt"
  | "price_variance"
  | "currency_mismatch"
  | "duplicate_invoice";

export interface LineFinding {
  readonly lineNo: number;
  readonly itemId: string;
  readonly reason: BlockReason;
  readonly message: string;
  /** Sapmanın parasal büyüklüğü — önceliklendirme için. */
  readonly impact: number;
  readonly detail: Record<string, number | string | null>;
}

export interface MatchResult {
  readonly invoiceId: string;
  readonly status: "matched" | "blocked";
  readonly findings: readonly LineFinding[];
  /** Toplam sapma tutarı — pozitif = fazla faturalanmış. */
  readonly totalVariance: number;
  readonly invoiceTotal: number;
  readonly poTotal: number;
  /** 0-100. Eşleşme ne kadar temiz? */
  readonly confidence: number;
}

export interface MatchInput {
  readonly invoice: Invoice;
  readonly poLines: readonly PurchaseOrderLine[];
  readonly receipts: readonly GoodsReceiptLine[];
  readonly tolerance?: MatchTolerance;
  /** Aynı tedarikçiden aynı belge numarası daha önce geldi mi? */
  readonly previousDocumentNos?: readonly string[];
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Fiyat sapması bloklanmalı mı?
 * HEM yüzde HEM mutlak eşik aşılmalı — gerekçe dosya başında.
 */
export function exceedsPriceTolerance(
  poPrice: number,
  invoicePrice: number,
  quantity: number,
  tolerance: MatchTolerance,
): { exceeded: boolean; percent: number; absolute: number } {
  const deltaPerUnit = invoicePrice - poPrice;
  const absolute = Math.abs(deltaPerUnit * quantity);
  const percent = poPrice === 0 ? (deltaPerUnit === 0 ? 0 : 100) : Math.abs(deltaPerUnit / poPrice) * 100;
  return {
    exceeded: percent > tolerance.pricePercent && absolute > tolerance.priceAbsolute,
    percent: round2(percent),
    absolute: round2(absolute),
  };
}

export function matchInvoice(input: MatchInput): MatchResult {
  const tolerance = input.tolerance ?? DEFAULT_TOLERANCE;
  const findings: LineFinding[] = [];
  let totalVariance = 0;
  let invoiceTotal = 0;
  let poTotal = 0;

  // ── Belge seviyesi: mükerrer fatura
  if (input.previousDocumentNos?.includes(input.invoice.documentNo)) {
    findings.push({
      lineNo: 0,
      itemId: "-",
      reason: "duplicate_invoice",
      message: `Bu tedarikçiden "${input.invoice.documentNo}" numaralı fatura daha önce kaydedilmiş. Mükerrer ödeme riski.`,
      impact: 0,
      detail: { documentNo: input.invoice.documentNo },
    });
  }

  for (const line of input.invoice.lines) {
    const lineTotal = line.quantity * line.unitPrice;
    invoiceTotal += lineTotal;

    // ── Sipariş referansı var mı?
    if (!line.poId || line.poLineNo === null) {
      findings.push({
        lineNo: line.lineNo,
        itemId: line.itemId,
        reason: "no_po_reference",
        message: `Kalem ${line.lineNo} hiçbir satın alma siparişine bağlı değil. Siparişsiz fatura onaya gidemez.`,
        impact: round2(lineTotal),
        detail: { lineTotal: round2(lineTotal) },
      });
      totalVariance += lineTotal;
      continue;
    }

    const poLine = input.poLines.find(
      (p) => p.poId === line.poId && p.lineNo === line.poLineNo,
    );
    if (!poLine) {
      findings.push({
        lineNo: line.lineNo,
        itemId: line.itemId,
        reason: "po_line_not_found",
        message: `${line.poId} / kalem ${line.poLineNo} sistemde bulunamadı.`,
        impact: round2(lineTotal),
        detail: { poId: line.poId, poLineNo: line.poLineNo },
      });
      totalVariance += lineTotal;
      continue;
    }

    poTotal += poLine.quantity * poLine.unitPrice;

    // ── Para birimi
    if (poLine.currency !== line.currency) {
      findings.push({
        lineNo: line.lineNo,
        itemId: line.itemId,
        reason: "currency_mismatch",
        message: `Sipariş ${poLine.currency}, fatura ${line.currency}. Para birimi uyuşmuyor.`,
        impact: round2(lineTotal),
        detail: { poCurrency: poLine.currency, invoiceCurrency: line.currency },
      });
      continue;
    }

    // ── Mal kabul edildi mi, ne kadarı?
    const received = input.receipts
      .filter((r) => r.poId === line.poId && r.poLineNo === line.poLineNo)
      .reduce((s, r) => s + r.quantity, 0);

    if (received === 0) {
      findings.push({
        lineNo: line.lineNo,
        itemId: line.itemId,
        reason: "no_goods_receipt",
        message: `Kalem ${line.lineNo} için mal kabul kaydı yok. Teslim alınmamış mal faturalanamaz.`,
        impact: round2(lineTotal),
        detail: { invoicedQty: line.quantity, receivedQty: 0 },
      });
      totalVariance += lineTotal;
      continue;
    }

    const qtyAllowance = received * (1 + tolerance.quantityPercent / 100);
    if (line.quantity > qtyAllowance) {
      const excess = line.quantity - received;
      findings.push({
        lineNo: line.lineNo,
        itemId: line.itemId,
        reason: "quantity_exceeds_receipt",
        message:
          `Kalem ${line.lineNo}: ${line.quantity} adet faturalanmış ama ${received} adet teslim alınmış. ` +
          `${round2(excess)} adet fazla faturalama.`,
        impact: round2(excess * line.unitPrice),
        detail: { invoicedQty: line.quantity, receivedQty: received, excess: round2(excess) },
      });
      totalVariance += excess * line.unitPrice;
    }

    // ── Fiyat sapması
    const price = exceedsPriceTolerance(
      poLine.unitPrice,
      line.unitPrice,
      Math.min(line.quantity, received),
      tolerance,
    );
    if (price.exceeded) {
      const direction = line.unitPrice > poLine.unitPrice ? "yüksek" : "düşük";
      findings.push({
        lineNo: line.lineNo,
        itemId: line.itemId,
        reason: "price_variance",
        message:
          `Kalem ${line.lineNo}: sipariş fiyatı ${poLine.unitPrice} ${poLine.currency}, ` +
          `fatura fiyatı ${line.unitPrice} ${line.currency} — %${price.percent} ${direction}, ` +
          `toplam etki ${price.absolute} ${line.currency}.`,
        impact: price.absolute,
        detail: {
          poUnitPrice: poLine.unitPrice,
          invoiceUnitPrice: line.unitPrice,
          variancePercent: price.percent,
          varianceAmount: price.absolute,
        },
      });
      totalVariance += (line.unitPrice - poLine.unitPrice) * Math.min(line.quantity, received);
    }
  }

  const blocked = findings.length > 0;
  // Güven skoru: temiz eşleşme 100; her bulgu, parasal etkisine göre düşürür.
  const impactRatio = invoiceTotal > 0 ? Math.abs(totalVariance) / invoiceTotal : 0;
  const confidence = blocked
    ? Math.max(20, Math.round(100 - findings.length * 8 - impactRatio * 50))
    : 100;

  return {
    invoiceId: input.invoice.id,
    status: blocked ? "blocked" : "matched",
    findings: [...findings].sort((a, b) => b.impact - a.impact),
    totalVariance: round2(totalVariance),
    invoiceTotal: round2(invoiceTotal),
    poTotal: round2(poTotal),
    confidence,
  };
}
