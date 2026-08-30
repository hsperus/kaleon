/**
 * Seri numarası izleme.
 *
 * PARTİ İLE SERİ FARKLI SORULARA CEVAP VERİR. Parti bir yığını izler
 * ("bu partiden 500 kg üretildi"); seri TEK BİR NESNEYİ izler ("bu
 * makinenin garantisi ne zaman bitiyor, kime satıldı, hangi motor
 * takılı"). Makine, cihaz ve garanti izlenen ürünlerde parti izleme
 * yetmez: müşteri "benim aldığım cihaz" der, parti numarası onu
 * göstermez.
 *
 * SERİ NUMARASI TEKTİR VE TEKRAR KULLANILMAZ. Kullanılsaydı, iki farklı
 * ürünün geçmişi tek kayıtta birleşir ve garanti hangi ürüne ait
 * anlaşılamazdı.
 *
 * BİR SERİ AYNI ANDA TEK YERDE OLUR. Stokta, müşterideki veya serviste;
 * ikisinde birden görünmesi, envanterin iki kez sayılması demektir.
 */

export const SERIAL_STATES = ["stokta", "sevk_edildi", "serviste", "hurda"] as const;
export type SerialState = (typeof SERIAL_STATES)[number];

export class SerialError extends Error {
  readonly code = "serial";
  constructor(message: string) {
    super(message);
    this.name = "SerialError";
  }
}

/** Seri numarası biçimi — boşluk ve büyük/küçük harf farkı temizlenir. */
export function normalizeSerial(serial: string): string {
  const s = serial.trim().toLocaleUpperCase("tr").replace(/\s+/g, "");
  if (s.length < 3) {
    throw new SerialError(
      `Seri numarası çok kısa: "${serial}". En az üç karakter olmalı; kısa numaralar ` +
        `farklı ürünlerde çakışır.`,
    );
  }
  return s;
}

/** Durum geçişi geçerli mi. */
export function assertTransition(from: SerialState, to: SerialState): void {
  if (from === to) {
    throw new SerialError(`Seri zaten "${from}" durumunda.`);
  }
  if (from === "hurda") {
    throw new SerialError(
      "Hurdaya ayrılmış seri yeniden kullanılamaz. Kullanılabilseydi, iki farklı " +
        "ürünün geçmişi tek kayıtta birleşir ve garanti hangi ürüne ait anlaşılamazdı.",
    );
  }
  if (from === "sevk_edildi" && to === "stokta") {
    throw new SerialError(
      "Sevk edilmiş seri doğrudan stoğa dönemez. İade ediliyorsa önce servise " +
        "alınmalı ve kontrol edilmelidir.",
    );
  }
}

export interface WarrantyInput {
  readonly shippedAt: Date | null;
  /** Garanti süresi (ay). Tanımsızsa null. */
  readonly warrantyMonths: number | null;
  readonly on: Date;
}

export interface WarrantyStatus {
  readonly covered: boolean | null;
  readonly expiresAt: string | null;
  readonly daysRemaining: number | null;
  readonly explanation: string;
}

/**
 * Garanti durumu.
 *
 * SEVK TARİHİ YOKSA GARANTİ HESAPLANMAZ. "Garanti yok" demek, hakkı olan
 * müşteriye ücret çıkarmaktır; "garanti var" demek de bedelsiz servis
 * vermek. İkisi de yanlış; doğru cevap "bilinmiyor"dur.
 */
export function warrantyStatus(input: WarrantyInput): WarrantyStatus {
  if (input.shippedAt === null) {
    return {
      covered: null,
      expiresAt: null,
      daysRemaining: null,
      explanation:
        "Sevk tarihi bilinmiyor; garanti süresi HESAPLANAMIYOR. 'Garanti yok' demek " +
        "hakkı olan müşteriye ücret çıkarmaktır.",
    };
  }
  if (input.warrantyMonths === null) {
    return {
      covered: null,
      expiresAt: null,
      daysRemaining: null,
      explanation: "Bu ürün için garanti süresi tanımlı değil; kapsam belirlenemiyor.",
    };
  }

  const expires = new Date(input.shippedAt.getTime());
  expires.setUTCMonth(expires.getUTCMonth() + input.warrantyMonths);
  const daysRemaining = Math.ceil((expires.getTime() - input.on.getTime()) / 86_400_000);

  return {
    covered: daysRemaining > 0,
    expiresAt: expires.toISOString().slice(0, 10),
    daysRemaining,
    explanation:
      daysRemaining > 0
        ? `Garanti ${expires.toISOString().slice(0, 10)} tarihine kadar geçerli ` +
          `(${daysRemaining} gün kaldı).`
        : `Garanti ${expires.toISOString().slice(0, 10)} tarihinde doldu ` +
          `(${Math.abs(daysRemaining)} gün önce).`,
  };
}
