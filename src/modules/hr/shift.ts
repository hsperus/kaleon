/**
 * Vardiya tanımı ve ataması.
 *
 * VARDİYA BİR ZAMAN ARALIĞI DEĞİL, BİR ÇALIŞMA KURALIDIR. Gece vardiyası
 * 22:00–06:00'da biter ve GÜN DEĞİŞTİRİR; saat farkını basitçe çıkarmak
 * negatif süre verir. Türkiye'de gece çalışması 7,5 saati aşamaz
 * (İş Kanunu md. 69) ve bu sınır vardiya tanımında kontrol edilmelidir —
 * puantajda yakalanırsa iş zaten olmuştur.
 *
 * ÇAKIŞAN ATAMA YAPILAMAZ. Bir kişi aynı anda iki vardiyada olamaz;
 * olabilseydi mesai iki kez hesaplanır ve bordro şişerdi.
 */

export class ShiftError extends Error {
  readonly code = "shift";
  constructor(message: string) {
    super(message);
    this.name = "ShiftError";
  }
}

/** Gece çalışması üst sınırı — İş Kanunu md. 69. */
export const MAX_NIGHT_HOURS = 7.5;
/** Günlük çalışma üst sınırı — md. 63. */
export const MAX_DAILY_HOURS = 11;
/** Haftalık çalışma üst sınırı — md. 63. */
export const MAX_WEEKLY_HOURS = 45;

export interface ShiftDefinition {
  readonly code: string;
  readonly name: string;
  /** "08:00" biçiminde. */
  readonly startsAt: string;
  readonly endsAt: string;
  /** Ara dinlenme, dakika (md. 68). */
  readonly breakMinutes: number;
  readonly isNight: boolean;
}

function toMinutes(hhmm: string): number {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  if (!m) throw new ShiftError(`Geçersiz saat biçimi: "${hhmm}". Beklenen: SS:DD`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * Vardiyanın net çalışma süresi (saat).
 *
 * GÜN AŞAN VARDİYA DOĞRU HESAPLANIR: bitiş başlangıçtan küçükse ertesi
 * güne taşınmıştır. Basit çıkarma yapılsaydı gece vardiyası eksi süre
 * verir ve mesai hesabı sessizce bozulurdu.
 */
export function shiftHours(shift: ShiftDefinition): number {
  const start = toMinutes(shift.startsAt);
  const end = toMinutes(shift.endsAt);
  const span = end > start ? end - start : end + 24 * 60 - start;
  const net = span - shift.breakMinutes;
  if (net <= 0) {
    throw new ShiftError(
      `"${shift.code}" vardiyasının net süresi sıfır veya negatif; ara dinlenme ` +
        `(${shift.breakMinutes} dk) vardiya süresinden uzun olamaz.`,
    );
  }
  return Math.round((net / 60) * 100) / 100;
}

/**
 * Ara dinlenme kanunî asgarisi (md. 68):
 *   4 saate kadar        → 15 dakika
 *   4–7,5 saat (dahil)   → 30 dakika
 *   7,5 saatten fazla    → 60 dakika
 */
export function requiredBreakMinutes(grossHours: number): number {
  if (grossHours <= 4) return 15;
  if (grossHours <= 7.5) return 30;
  return 60;
}

export function validateShift(shift: ShiftDefinition): { hours: number; warnings: string[] } {
  const start = toMinutes(shift.startsAt);
  const end = toMinutes(shift.endsAt);
  const grossHours = ((end > start ? end - start : end + 24 * 60 - start) / 60);
  const hours = shiftHours(shift);
  const warnings: string[] = [];

  const requiredBreak = requiredBreakMinutes(grossHours);
  if (shift.breakMinutes < requiredBreak) {
    throw new ShiftError(
      `${grossHours.toFixed(1)} saatlik vardiyada ara dinlenme en az ${requiredBreak} dakika ` +
        `olmalıdır (İş Kanunu md. 68); tanımlanan ${shift.breakMinutes} dakika.`,
    );
  }

  if (shift.isNight && hours > MAX_NIGHT_HOURS) {
    throw new ShiftError(
      `Gece çalışması ${MAX_NIGHT_HOURS} saati aşamaz (İş Kanunu md. 69); ` +
        `"${shift.code}" vardiyası ${hours} saat.`,
    );
  }

  if (hours > MAX_DAILY_HOURS) {
    throw new ShiftError(
      `Günlük çalışma ${MAX_DAILY_HOURS} saati aşamaz (İş Kanunu md. 63); ` +
        `"${shift.code}" vardiyası ${hours} saat.`,
    );
  }

  // 22:00–06:00 arasına giren bir vardiya gece vardiyasıdır; işaretlenmemişse
  // gece sınırı hiç kontrol edilmez ve kural sessizce atlanır.
  const touchesNight = start >= 20 * 60 || start < 6 * 60 || (end > start ? false : true);
  if (touchesNight && !shift.isNight) {
    warnings.push(
      `"${shift.code}" vardiyası gece saatlerine giriyor ama gece vardiyası olarak ` +
        `işaretlenmemiş; ${MAX_NIGHT_HOURS} saat sınırı uygulanmayacak.`,
    );
  }

  return { hours, warnings };
}

/** Haftalık toplam çalışma sınırı aşıldı mı. */
export function weeklyOvertime(totalHours: number): { overtime: number; exceedsLimit: boolean } {
  const overtime = Math.max(0, Math.round((totalHours - MAX_WEEKLY_HOURS) * 100) / 100);
  return { overtime, exceedsLimit: totalHours > MAX_WEEKLY_HOURS };
}
