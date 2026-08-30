/**
 * Ödeme ve fatura kapama.
 *
 * ÖDEME BİR FATURAYA BAĞLANIR, HAVADA DURMAZ. Bağlanmayan ödeme, cari
 * hesapta "bakiye var ama hangi faturaya ait bilinmiyor" durumunu yaratır
 * ve mutabakat imkânsızlaşır. Bir tedarikçi "şu faturayı ödemediniz"
 * dediğinde cevap verilemez.
 *
 * BLOKE FATURA ÖDENMEZ. Üç yönlü mutabakat (sipariş–irsaliye–fatura)
 * bir farkı bloke etmişse, ödeme o farkı yok sayarak geçer ve kontrolün
 * tamamı boşa çıkar. Bloke faturanın ödenmesi için önce blokenin
 * çözülmesi gerekir.
 *
 * FAZLA ÖDEME ENGELLENİR. Fatura tutarından fazlası, bir sonraki
 * mutabakatta "bizde alacağınız var" tartışmasına dönüşür ve genellikle
 * kimse geri istemez.
 */

export const PAYMENT_METHODS = ["havale", "eft", "cek", "senet", "nakit", "kredi_karti"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_DIRECTIONS = ["outgoing", "incoming"] as const;

export class PaymentError extends Error {
  readonly code = "payment";
  constructor(message: string) {
    super(message);
    this.name = "PaymentError";
  }
}

export interface InvoiceBalance {
  readonly documentNo: string;
  readonly totalAmount: number;
  readonly paidAmount: number;
  readonly currency: string;
  /** matched | blocked | pending */
  readonly matchStatus: string;
}

export function openAmount(inv: InvoiceBalance): number {
  return Math.round((inv.totalAmount - inv.paidAmount) * 100) / 100;
}

/**
 * Bir faturaya şu kadar ödeme yapılabilir mi.
 *
 * MESAJ RAKAMLARI İÇERİR: "fazla ödeme" demek muhasebeciye hiçbir şey
 * anlatmaz; fatura tutarı, ödenmiş kısım ve kalan yazılırsa hatanın
 * nerede olduğu kendiliğinden görünür.
 */
export function assertPayable(inv: InvoiceBalance, amount: number, currency: string): void {
  if (!(amount > 0)) {
    throw new PaymentError("Ödeme tutarı sıfırdan büyük olmalıdır.");
  }
  if (currency !== inv.currency) {
    throw new PaymentError(
      `${inv.documentNo} faturası ${inv.currency} cinsinden; ${currency} ödeme ` +
        `doğrudan eşleştirilemez. Kur farkı ayrı bir kayıt gerektirir.`,
    );
  }
  if (inv.matchStatus === "blocked") {
    throw new PaymentError(
      `${inv.documentNo} faturası MUTABAKAT FARKI nedeniyle bloke; ödenemez. ` +
        `Ödeme, farkı yok sayarak geçer ve kontrolün tamamını boşa çıkarır.`,
    );
  }

  const open = openAmount(inv);
  if (amount > open + 1e-9) {
    throw new PaymentError(
      `${inv.documentNo}: fatura tutarı ${fmt(inv.totalAmount)}, ödenmiş ` +
        `${fmt(inv.paidAmount)}, kalan ${fmt(open)}. ${fmt(amount)} ödenemez — ` +
        `fazlası cari hesapta çözülemeyen bir bakiye bırakır.`,
    );
  }
}

export interface Allocation {
  readonly invoiceNo: string;
  readonly amount: number;
}

/**
 * Bir ödemenin fatura dağıtımını doğrular.
 *
 * DAĞITIM TOPLAMI ÖDEME TUTARINA EŞİT OLMALIDIR. Eksik dağıtılan kısım
 * "avans" olarak havada kalır ve hiçbir faturaya bağlanmaz — tam da
 * engellemeye çalıştığımız durum.
 */
export function assertFullyAllocated(paymentAmount: number, allocations: readonly Allocation[]): void {
  if (allocations.length === 0) {
    throw new PaymentError(
      "Ödeme en az bir faturaya bağlanmalıdır; bağlanmayan ödeme mutabakatta çözülemez.",
    );
  }
  const sum = allocations.reduce((s, a) => s + a.amount, 0);
  const diff = Math.round((sum - paymentAmount) * 100) / 100;
  if (diff !== 0) {
    throw new PaymentError(
      `Ödeme tutarı ${fmt(paymentAmount)} ama faturalara dağıtılan ${fmt(sum)} ` +
        `(fark ${fmt(diff)}). Dağıtılmayan tutar hiçbir faturaya bağlanmaz.`,
    );
  }
}

/** Vade geçmiş mi ve kaç gün. */
export function overdueDays(dueDate: Date, on: Date): number {
  return Math.max(0, Math.round((on.getTime() - dueDate.getTime()) / 86_400_000));
}

function fmt(n: number): string {
  return new Intl.NumberFormat("tr-TR", { minimumFractionDigits: 2 }).format(n);
}
