/**
 * Satın alma talebi (talep → onay → sipariş).
 *
 * TALEP VE SİPARİŞ AYRI BELGELERDİR. Tek belge olsaydı, "isteyen" ile
 * "satın alan" aynı kişi olurdu ve şirketin en klasik suistimali burada
 * doğardı: kendi talebini kendi onaylayıp kendi tedarikçisine sipariş
 * geçmek. Ayrım bir bürokrasi değil, GÖREVLER AYRILIĞININ kendisidir.
 *
 * ONAY EŞİĞİ TUTARA GÖRE DEĞİŞİR. Her talebi patrona götürmek, onayı
 * anlamsız bir tıklamaya çevirir ve gerçekten bakılması gereken talep de
 * o gürültünün içinde kaybolur.
 *
 * TALEP EDEN ONAYLAYAMAZ — tutarı ne olursa olsun. Bu kural eşikten
 * bağımsızdır; en küçük tutarda bile kendi talebini onaylayan biri,
 * kontrolü tümüyle devre dışı bırakır.
 */

export const REQUISITION_STATUSES = [
  "draft",
  "submitted",
  "approved",
  "rejected",
  "ordered",
  "cancelled",
] as const;
export type RequisitionStatus = (typeof REQUISITION_STATUSES)[number];

export class RequisitionError extends Error {
  readonly code = "requisition";
  constructor(message: string) {
    super(message);
    this.name = "RequisitionError";
  }
}

/**
 * Onay eşikleri — TL cinsinden, tutarın ÜSTÜNDE olan rol gerekir.
 *
 * Eşikler yükselen sırada tutulur ve ilk aşılan eşiğin rolü aranır.
 */
export const APPROVAL_THRESHOLDS: readonly {
  upTo: number;
  requires: "satin_alma" | "cfo" | "patron";
}[] = [
  { upTo: 50_000, requires: "satin_alma" },
  { upTo: 500_000, requires: "cfo" },
  { upTo: Number.POSITIVE_INFINITY, requires: "patron" },
];

export function approverFor(totalAmount: number): "satin_alma" | "cfo" | "patron" {
  for (const t of APPROVAL_THRESHOLDS) {
    if (totalAmount <= t.upTo) return t.requires;
  }
  return "patron";
}

export interface RequisitionLine {
  readonly lineNo: number;
  readonly itemCode: string;
  readonly quantity: number;
  readonly uom: string;
  /** Tahmini birim fiyat. BİLİNMİYORSA null — sıfır "bedava" demektir. */
  readonly estimatedPrice: number | null;
  readonly neededBy: Date;
}

/**
 * Talebin tahmini tutarı.
 *
 * FİYATI BİLİNMEYEN KALEM TOPLAMA GİRMEZ ve bu SÖYLENİR: tutar
 * olduğundan düşük çıkarsa talep, gerçekte gerektirenden daha düşük bir
 * onay eşiğine düşer ve kontrol atlanmış olur.
 */
export function estimateTotal(lines: readonly RequisitionLine[]): {
  total: number;
  unpricedLines: readonly number[];
} {
  let total = 0;
  const unpriced: number[] = [];
  for (const l of lines) {
    if (l.estimatedPrice === null) {
      unpriced.push(l.lineNo);
      continue;
    }
    total += l.quantity * l.estimatedPrice;
  }
  return { total: Math.round(total * 100) / 100, unpricedLines: unpriced };
}

/** Talep onaylanabilir mi. */
export function assertApprovable(input: {
  status: RequisitionStatus;
  requestedBy: string;
  approverId: string;
  approverRoles: readonly string[];
  totalAmount: number;
  unpricedLines: readonly number[];
}): void {
  if (input.status !== "submitted") {
    throw new RequisitionError(
      input.status === "draft"
        ? "Talep henüz gönderilmemiş; taslak onaylanamaz."
        : `Talep ${input.status} durumunda; yeniden onaylanamaz.`,
    );
  }

  // KENDİ TALEBİNİ ONAYLAYAMAZ — tutar ne olursa olsun.
  if (input.requestedBy === input.approverId) {
    throw new RequisitionError(
      "Kendi talebinizi onaylayamazsınız. Talebi başka bir yetkili onaylamalıdır.",
    );
  }

  // FİYATSIZ KALEM ONAY EŞİĞİNİ DÜŞÜRÜR. 300.000 TL'lik bir talep, iki
  // kalemi fiyatsız olduğu için 40.000 TL görünüp satın almacının kendi
  // onayıyla geçebilir. Bu bir boşluk değil, kontrolün tamamen atlanmasıdır.
  if (input.unpricedLines.length > 0) {
    throw new RequisitionError(
      `${input.unpricedLines.join(", ")}. kalemlerde tahmini fiyat yok; onay eşiği ` +
        `hesaplanamaz. Fiyatsız kalem, talebi gerçekte gerektirdiğinden düşük bir ` +
        `onay seviyesine düşürür.`,
    );
  }

  const required = approverFor(input.totalAmount);
  if (!input.approverRoles.includes(required) && !input.approverRoles.includes("patron")) {
    throw new RequisitionError(
      `${formatTry(input.totalAmount)} tutarındaki talep için "${roleLabel(required)}" ` +
        `onayı gerekir.`,
    );
  }
}

/** Onaylı talep siparişe dönüştürülebilir mi. */
export function assertOrderable(status: RequisitionStatus): void {
  if (status === "ordered") {
    throw new RequisitionError("Bu talep zaten siparişe dönüştürülmüş.");
  }
  if (status !== "approved") {
    throw new RequisitionError(
      `Talep ${status} durumunda; yalnızca ONAYLI talep siparişe dönüştürülebilir.`,
    );
  }
}

function formatTry(n: number): string {
  return `${new Intl.NumberFormat("tr-TR", { minimumFractionDigits: 2 }).format(n)} TL`;
}

function roleLabel(role: string): string {
  return role === "cfo" ? "CFO" : role === "patron" ? "Patron" : "Satın alma";
}
