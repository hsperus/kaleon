/**
 * Yıllık izin ve izin talebi.
 *
 * İZİN HAKKI KANUNLA BELİRLİDİR, ŞİRKET POLİTİKASIYLA DEĞİL. 4857 sayılı
 * İş Kanunu md. 53 asgari süreleri koyar; şirket bunun ÜSTÜNE çıkabilir,
 * altına inemez. Sistemin hesapladığı hak bu tabandır ve şirket
 * politikası ancak ekleme yapar.
 *
 * KADEMELER (md. 53):
 *   1 yıl – 5 yıl (5 dahil)  → 14 gün
 *   5 yıl – 15 yıl           → 20 gün
 *   15 yıl ve üzeri          → 26 gün
 * 18 yaşından küçük ve 50 yaşından büyük çalışanlara EN AZ 20 gün verilir
 * (md. 53/son) — kıdemi ne olursa olsun.
 *
 * BİR YILI DOLDURMADAN YILLIK İZİN HAKKI DOĞMAZ (md. 53/1). Bu bir
 * ayrıntı değil: sistemin 11 aylık çalışana izin hakkı göstermesi, İK'nın
 * kanuna aykırı bir vaatte bulunmasına yol açar.
 *
 * İZİN GÜNLERİ İŞ GÜNÜDÜR, TAKVİM GÜNÜ DEĞİL. Pazar ve resmî tatil
 * izinden düşülmez (md. 56); düşülürse çalışan hakkını eksik kullanır.
 */

export const LEAVE_TYPES = [
  "yillik",
  "mazeret",
  "hastalik",
  "ucretsiz",
  "dogum",
  "babalik",
  "evlilik",
  "olum",
] as const;
export type LeaveType = (typeof LEAVE_TYPES)[number];

export const LEAVE_STATUSES = ["submitted", "approved", "rejected", "cancelled"] as const;
export type LeaveStatus = (typeof LEAVE_STATUSES)[number];

export class LeaveError extends Error {
  readonly code = "leave";
  constructor(message: string) {
    super(message);
    this.name = "LeaveError";
  }
}

/**
 * Kanunla belirli mazeret izinleri (md. 46 ve ek md. 2).
 *
 * BUNLAR YILLIK İZİNDEN DÜŞÜLMEZ. Düşülürse çalışan, kanunen hakkı olan
 * bir izni kendi yıllık izninden ödemiş olur.
 */
export const STATUTORY_LEAVE_DAYS: Readonly<Partial<Record<LeaveType, number>>> = {
  evlilik: 3,
  olum: 3,
  babalik: 5,
};

/** Yıllık izinden düşülen tek tür yıllık izindir. */
export function deductsFromAnnual(type: LeaveType): boolean {
  return type === "yillik";
}

export interface Entitlement {
  readonly days: number;
  /** Hakkın hangi kuraldan geldiği — İK'ya ve çalışana açıklanabilir olmalı. */
  readonly basis: string;
  readonly seniorityYears: number;
}

/**
 * Yıllık izin hakkını hesaplar.
 *
 * YAŞ BİLİNMİYORSA KADEME UYGULANMAZ AMA BU SÖYLENİR: 50 yaş üstü bir
 * çalışana 14 gün göstermek, kanunen 20 gün olan hakkı eksik göstermektir.
 */
export function annualEntitlement(input: {
  hiredAt: Date;
  on: Date;
  birthDate?: Date | null;
}): Entitlement {
  const years = completedYears(input.hiredAt, input.on);

  if (years < 1) {
    return {
      days: 0,
      basis:
        "İş Kanunu md. 53: bir yılı doldurmayan çalışanın yıllık ücretli izin hakkı doğmaz. " +
        `İşe giriş ${input.hiredAt.toISOString().slice(0, 10)}; kıdem 1 yılı dolduğunda hak doğar.`,
      seniorityYears: years,
    };
  }

  let days: number;
  let basis: string;
  if (years <= 5) {
    days = 14;
    basis = "İş Kanunu md. 53: 1–5 yıl kıdem → 14 gün.";
  } else if (years < 15) {
    days = 20;
    basis = "İş Kanunu md. 53: 5–15 yıl kıdem → 20 gün.";
  } else {
    days = 26;
    basis = "İş Kanunu md. 53: 15 yıl ve üzeri kıdem → 26 gün.";
  }

  if (input.birthDate) {
    const age = completedYears(input.birthDate, input.on);
    if ((age < 18 || age > 50) && days < 20) {
      days = 20;
      basis =
        `İş Kanunu md. 53/son: ${age} yaşındaki çalışana kıdeminden bağımsız olarak ` +
        `en az 20 gün verilir.`;
    }
  }

  return { days, basis, seniorityYears: years };
}

export function completedYears(from: Date, to: Date): number {
  let years = to.getUTCFullYear() - from.getUTCFullYear();
  const monthDiff = to.getUTCMonth() - from.getUTCMonth();
  if (monthDiff < 0 || (monthDiff === 0 && to.getUTCDate() < from.getUTCDate())) {
    years -= 1;
  }
  return Math.max(0, years);
}

/**
 * İzin gün sayısı — İŞ GÜNÜ olarak.
 *
 * Pazar ve verilen resmî tatiller sayılmaz (md. 56). Cumartesi
 * SAYILIR: kanun yalnızca hafta tatilini (genelde pazar) hariç tutar ve
 * çoğu işletmede cumartesi iş günüdür. İşletme cumartesiyi tatil
 * yapıyorsa bunu `nonWorkingDays` ile bildirir.
 */
export function workingDaysBetween(
  from: Date,
  to: Date,
  holidays: readonly Date[] = [],
  weekendDays: readonly number[] = [0],
): number {
  if (to.getTime() < from.getTime()) {
    throw new LeaveError("İzin bitiş tarihi başlangıçtan önce olamaz.");
  }
  const holidaySet = new Set(holidays.map((h) => h.toISOString().slice(0, 10)));
  let count = 0;
  const cursor = new Date(from.getTime());
  while (cursor.getTime() <= to.getTime()) {
    const isWeekend = weekendDays.includes(cursor.getUTCDay());
    const isHoliday = holidaySet.has(cursor.toISOString().slice(0, 10));
    if (!isWeekend && !isHoliday) count += 1;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return count;
}

export interface LeaveBalance {
  readonly entitled: number;
  readonly used: number;
  readonly pending: number;
  readonly remaining: number;
  readonly basis: string;
}

export function balance(input: {
  entitlement: Entitlement;
  usedDays: number;
  pendingDays: number;
  /** Devreden gün — kullanılmayan izin bir sonraki yıla aktarılır. */
  carriedOver?: number;
}): LeaveBalance {
  const entitled = input.entitlement.days + (input.carriedOver ?? 0);
  return {
    entitled,
    used: input.usedDays,
    pending: input.pendingDays,
    // BEKLEYEN TALEP DE DÜŞÜLÜR. Düşülmeseydi çalışan, onay bekleyen
    // izniyle birlikte hakkından fazlasını talep edebilirdi.
    remaining: Math.round((entitled - input.usedDays - input.pendingDays) * 10) / 10,
    basis: input.entitlement.basis,
  };
}

/** İzin talebi kabul edilebilir mi. */
export function assertRequestable(input: {
  type: LeaveType;
  days: number;
  balance: LeaveBalance;
  overlapping: readonly { from: string; to: string }[];
}): void {
  if (input.days <= 0) {
    throw new LeaveError(
      "İzin en az bir iş günü olmalıdır. Seçilen aralıkta hafta tatili ve resmî " +
        "tatil dışında çalışılan gün yok.",
    );
  }

  // ÜST ÜSTE BİNEN İZİN KABUL EDİLMEZ. Edilseydi aynı gün iki kez izne
  // sayılır ve bakiye iki kez düşerdi.
  if (input.overlapping.length > 0) {
    const o = input.overlapping[0]!;
    throw new LeaveError(
      `Bu tarihlerde zaten bir izin var (${o.from} – ${o.to}). Çakışan izin talebi ` +
        `alınamaz; önce mevcut izin iptal edilmelidir.`,
    );
  }

  if (!deductsFromAnnual(input.type)) return;

  if (input.balance.entitled === 0) {
    throw new LeaveError(input.balance.basis);
  }
  if (input.days > input.balance.remaining) {
    throw new LeaveError(
      `Kalan yıllık izin ${input.balance.remaining} gün ` +
        `(hak ${input.balance.entitled}, kullanılan ${input.balance.used}, ` +
        `onay bekleyen ${input.balance.pending}). ${input.days} günlük izin alınamaz.`,
    );
  }
}

/**
 * İzni onaylayan, izni isteyen olamaz.
 *
 * Satın alma talebindeki kuralın aynısı: bir kontrolün tek kişide
 * toplanması, kontrolü ortadan kaldırır.
 */
export function assertApprover(requestedBy: string, approverId: string): void {
  if (requestedBy === approverId) {
    throw new LeaveError("Kendi izin talebinizi onaylayamazsınız.");
  }
}
