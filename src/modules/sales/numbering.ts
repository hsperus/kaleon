/**
 * Belge numaralandırma.
 *
 * TÜRK VERGİ MEVZUATI KESİNTİSİZ SERİ İSTER. Fatura ve irsaliye numaraları
 * bir seri içinde ATLAMASIZ ilerlemelidir; 4 atlanıp 5'e geçmiş bir seri
 * incelemede "kaybolan belge" sorusunu doğurur. Bu yüzden numara,
 * belgeyle AYNI VERİTABANI İŞLEMİNDE alınır: belge yazılmazsa numara da
 * geri döner.
 *
 * NUMARA ÖNCEDEN ALINMAZ. "Önce numarayı al, sonra belgeyi hazırla"
 * yaklaşımı, hazırlık yarıda kalınca kullanılmamış numara bırakır. Numara
 * kaydın son adımıdır.
 *
 * SAYAÇ SATIRI KİLİTLENİR. İki eşzamanlı fatura aynı numarayı alırsa
 * benzersizlik kısıtı birini reddeder ve kullanıcı sebepsiz bir hata görür.
 * `UPDATE ... RETURNING` tek ifadede hem kilitler hem artırır.
 *
 * YIL DÖNÜMÜNDE SERİ SIFIRLANIR. Türkiye'de fatura numarası yıl bazlıdır;
 * 2026'nın ilk faturası 2025'in son numarasından devam etmez.
 */

export class NumberingError extends Error {
  readonly code = "numbering";
  constructor(message: string) {
    super(message);
    this.name = "NumberingError";
  }
}

/** Numaralandırılan belge türleri. */
export const DOCUMENT_KINDS = [
  "sales_order",
  "delivery",
  "sales_invoice",
  "purchase_order",
  "purchase_requisition",
  "payment",
  "journal",
  "sales_quotation",
  "purchase_rfq",
  "maintenance_order",
  "stock_count",
  "sales_credit_note",
] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export interface SeriesSpec {
  readonly kind: DocumentKind;
  /** Seri kodu: "SO", "IRS", "FTR"… Fatura serisi mevzuatta zorunludur. */
  readonly series: string;
  readonly year: number;
  /** Sıra numarasının basamak sayısı — sıfırla soldan doldurulur. */
  readonly padding: number;
}

/** Varsayılan seriler — kurulumda tenant başına açılır. */
export const DEFAULT_SERIES: Readonly<Record<DocumentKind, { series: string; padding: number }>> = {
  sales_order: { series: "SIP", padding: 5 },
  delivery: { series: "IRS", padding: 6 },
  sales_invoice: { series: "FTR", padding: 6 },
  purchase_order: { series: "SAT", padding: 5 },
  purchase_requisition: { series: "TLP", padding: 5 },
  payment: { series: "ODM", padding: 6 },
  journal: { series: "YEV", padding: 6 },
  sales_quotation: { series: "TKF", padding: 5 },
  purchase_rfq: { series: "RFQ", padding: 5 },
  maintenance_order: { series: "BKM", padding: 5 },
  stock_count: { series: "SAY", padding: 4 },
  // İADE VE DEKONT AYRI SERİ KULLANIR. Faturayla aynı seriyi
  // paylaşsalardı fatura numaralarında delik oluşur ve vergi dairesi
  // "şu numaralı fatura nerede" diye sorardı.
  sales_credit_note: { series: "IAD", padding: 6 },
};

/**
 * Numarayı biçimler: `FTR2026000431`.
 *
 * Biçim e-Fatura'nın beklediği yapıdır: 3 harfli seri + 4 haneli yıl +
 * 9 haneli sıra. Kendi biçimimizi uydurmak, entegratöre gönderirken
 * dönüştürme gerektirir ve dönüştürme hata kaynağıdır.
 */
export function formatDocumentNo(spec: SeriesSpec, sequence: number): string {
  if (!Number.isInteger(sequence) || sequence < 1) {
    throw new NumberingError(`Geçersiz sıra numarası: ${sequence}`);
  }
  // SERİ KODU YALNIZCA HARFTİR. Rakam içerseydi "FTR2026000431" numarası
  // geri ayrıştırılamazdı: seri "FTR2", yıl "0260" olarak da okunabilirdi.
  // Numaranın tek anlamı olmalı; belge arama buna dayanıyor.
  if (!/^[A-Z]{2,4}$/.test(spec.series)) {
    throw new NumberingError(
      `Seri kodu 2-4 büyük harf olmalıdır (rakam içeremez): "${spec.series}"`,
    );
  }
  const padded = String(sequence).padStart(spec.padding, "0");
  if (padded.length > spec.padding) {
    throw new NumberingError(
      `"${spec.series}" serisi ${spec.year} yılı için doldu: ${sequence} numarası ` +
        `${spec.padding} haneye sığmıyor. Seri uzunluğu artırılmalıdır.`,
    );
  }
  return `${spec.series}${spec.year}${padded}`;
}

/** Numarayı bileşenlerine ayırır — belge arama ve doğrulama için. */
export function parseDocumentNo(
  documentNo: string,
): { series: string; year: number; sequence: number } | null {
  const m = /^([A-Z]{2,4})(\d{4})(\d+)$/.exec(documentNo);
  if (!m) return null;
  return { series: m[1]!, year: Number(m[2]), sequence: Number(m[3]) };
}
