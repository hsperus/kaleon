/**
 * Muhasebe dönemi ve dönem kapama.
 *
 * KAPALI AYA KAYIT GİRİLEMEZ. Bir ay kapandığında beyanname verilmiş,
 * mizan çıkmış, belki kâr dağıtımı hesaplanmıştır. O aya sonradan giren
 * tek bir stok hareketi, verilmiş beyannameyi yanlış hâle getirir ve
 * düzeltme beyannamesi gerektirir. En kötüsü, kimse fark etmez: rapor
 * bugün bir sayı, üç ay sonra başka bir sayı verir ve hangisinin doğru
 * olduğunu söyleyecek kimse kalmaz.
 *
 * BU KURAL İZİNLE DEĞİL TARİHLE ÇALIŞIR. "Patron kapalı aya yazabilsin"
 * demek, kuralı hiç koymamakla aynı şeydir; kapalı dönem herkese kapalıdır.
 * Yazılması gerekiyorsa dönem AÇILIR — ve açılma işlemi iz bırakır.
 *
 * KİLİTLİ DÖNEM AÇILAMAZ. Kapama geri alınabilir (hata olur), ama
 * kilitleme kalıcıdır: yıl sonu kapanmış, bilanço çıkmış ve onaylanmıştır.
 */

export const PERIOD_STATUSES = ["open", "closed", "locked"] as const;
export type PeriodStatus = (typeof PERIOD_STATUSES)[number];

export class PeriodError extends Error {
  readonly code = "period_closed";
  constructor(message: string) {
    super(message);
    this.name = "PeriodError";
  }
}

export interface PeriodKey {
  readonly year: number;
  readonly month: number;
}

const MONTHS = [
  "Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran",
  "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık",
] as const;

export function periodOf(date: Date): PeriodKey {
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 };
}

export function periodLabel(p: PeriodKey): string {
  return `${MONTHS[p.month - 1]} ${p.year}`;
}

/** Karşılaştırılabilir tek sayı: 2026-06 → 202606. */
export function periodOrdinal(p: PeriodKey): number {
  return p.year * 100 + p.month;
}

/**
 * Bir tarihe kayıt yazılabilir mi.
 *
 * DÖNEM KAYDI YOKSA AÇIK SAYILIR. Aksi hâlde sistem kurulur kurulmaz
 * hiçbir şey yazılamazdı; kapama açık bir eylemdir, varsayılan değil.
 */
export function assertPostable(
  date: Date,
  status: PeriodStatus | null,
  what = "Bu kayıt",
): void {
  if (status === null || status === "open") return;
  const p = periodOf(date);
  throw new PeriodError(
    status === "locked"
      ? `${periodLabel(p)} dönemi KİLİTLİ; ${what.toLowerCase()} bu döneme yazılamaz. ` +
        `Kilitli dönem açılamaz — kayıt açık bir döneme alınmalıdır.`
      : `${periodLabel(p)} dönemi kapalı; ${what.toLowerCase()} bu döneme yazılamaz. ` +
        `Gerekiyorsa dönem yeniden açılmalıdır ve bu işlem iz bırakır.`,
  );
}

export interface CloseBlocker {
  readonly kind: string;
  readonly count: number;
  readonly message: string;
}

/**
 * Dönem kapatılabilir mi — kapamadan ÖNCE bakılır.
 *
 * SAP'de dönem kapama bir kontrol listesidir ve listeyi kullanıcı takip
 * eder; unutulan bir kalem aylar sonra ortaya çıkar. KAELON listeyi kendi
 * yürütür ve engelleri sayıyla söyler: "3 taslak fatura var" cümlesi,
 * "kapatmadan önce kontrol ediniz" uyarısından işe yarar bir şeydir.
 *
 * ÖNCEKİ DÖNEM AÇIKKEN SONRAKİ KAPATILAMAZ. Kapatılabilseydi Haziran
 * kapalı, Mayıs açık olurdu; Mayıs'a girilen bir kayıt Haziran mizanını
 * değiştirir ve kapalı dönem kapalı olmaktan çıkardı.
 */
export function closeBlockers(input: {
  draftInvoices: number;
  unvaluedMovements: number;
  openDeliveriesUninvoiced: number;
  previousPeriodOpen: boolean;
}): readonly CloseBlocker[] {
  const out: CloseBlocker[] = [];

  if (input.previousPeriodOpen) {
    out.push({
      kind: "previous_period_open",
      count: 1,
      message:
        "Önceki dönem hâlâ açık. Önce o kapatılmalı; aksi hâlde açık döneme " +
        "girilen bir kayıt kapalı dönemin mizanını değiştirir.",
    });
  }
  if (input.draftInvoices > 0) {
    out.push({
      kind: "draft_invoices",
      count: input.draftInvoices,
      message:
        `${input.draftInvoices} taslak fatura var. Kesilmemiş fatura döneme girmez; ` +
        `kapatılırsa bu tutarlar hiçbir döneme yazılamaz.`,
    });
  }
  if (input.unvaluedMovements > 0) {
    out.push({
      kind: "unvalued_movements",
      count: input.unvaluedMovements,
      message:
        `${input.unvaluedMovements} stok hareketinin maliyeti bilinmiyor. Dönem ` +
        `kapatılırsa bu hareketler kalıcı olarak değersiz kalır ve satılan malın ` +
        `maliyeti eksik hesaplanır.`,
    });
  }
  if (input.openDeliveriesUninvoiced > 0) {
    out.push({
      kind: "uninvoiced_deliveries",
      count: input.openDeliveriesUninvoiced,
      message:
        `${input.openDeliveriesUninvoiced} sevkiyat faturalanmamış. Mal çıkmış ama ` +
        `gelir yazılmamış; dönem kârı olduğundan düşük çıkar.`,
    });
  }

  return out;
}

/** Durum geçişi geçerli mi. */
export function assertTransition(from: PeriodStatus, to: PeriodStatus): void {
  if (from === "locked") {
    throw new PeriodError("Kilitli dönemin durumu değiştirilemez.");
  }
  if (from === to) {
    throw new PeriodError(`Dönem zaten ${from === "open" ? "açık" : "kapalı"}.`);
  }
  if (from === "open" && to === "locked") {
    throw new PeriodError("Dönem doğrudan kilitlenemez; önce kapatılmalıdır.");
  }
}
