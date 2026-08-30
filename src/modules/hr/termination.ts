/**
 * İşten çıkış hesabı — kıdem ve ihbar tazminatı.
 *
 * BU HESAP HUKUKİ SONUÇ DOĞURUR. Eksik ödenen kıdem tazminatı faiziyle
 * birlikte dava konusudur; fazla ödenen geri alınamaz. Bu yüzden sistem
 * TASLAK hazırlar, İK ve mali müşavir onaylar — anayasadaki "personel
 * işlemleri asla otomatik tamamlanamaz" kuralı burada geçerlidir.
 *
 * KIDEM TAZMİNATI (1475 sayılı Kanun md. 14):
 *   Her tam yıl için 30 günlük GİYDİRİLMİŞ brüt ücret. Artan süreler
 *   orantılı hesaplanır. Bir yılı doldurmayan hak kazanmaz.
 *   TAVAN VARDIR: yıllık olarak açıklanan kıdem tazminatı tavanını aşan
 *   kısım ödenmez — tavansız hesap, yüksek ücretlilerde kat kat fazla
 *   çıkar.
 *
 * İHBAR TAZMİNATI (4857 md. 17): kıdeme göre 2-8 hafta.
 *   6 aya kadar        2 hafta
 *   6 ay – 1,5 yıl     4 hafta
 *   1,5 – 3 yıl        6 hafta
 *   3 yıldan fazla     8 hafta
 *
 * HAK KAZANMA ÇIKIŞ SEBEBİNE BAĞLIDIR. İstifa eden kıdem alamaz (istisnalar
 * hariç); haklı nedenle derhal fesihte işveren ihbar ödemez. Sebebi
 * "bilinmiyor" olan bir çıkışta hesap YAPILMAZ — yanlış hesap, yanlış
 * ödemeden kötüdür çünkü doğru sanılır.
 */

import { completedYears } from "./leave.js";

export const TERMINATION_REASONS = [
  "isveren_feshi",
  "isci_istifasi",
  "isci_hakli_fesih",
  "isveren_hakli_fesih",
  "emeklilik",
  "askerlik",
  "evlilik",
  "olum",
  "belirli_sure_bitimi",
] as const;
export type TerminationReason = (typeof TERMINATION_REASONS)[number];

export class TerminationError extends Error {
  readonly code = "termination";
  constructor(message: string) {
    super(message);
    this.name = "TerminationError";
  }
}

/** Bir yıllık kıdem için ödenecek gün sayısı — md. 14. */
export const SEVERANCE_DAYS_PER_YEAR = 30;

/**
 * İhbar süresi (hafta) — md. 17.
 *
 * Kıdem AY cinsinden değerlendirilir; yıl bazlı bakılsaydı 17 aylık bir
 * çalışan 4 hafta yerine 6 hafta alırdı.
 */
export function noticeWeeks(seniorityMonths: number): number {
  if (seniorityMonths < 6) return 2;
  if (seniorityMonths < 18) return 4;
  if (seniorityMonths < 36) return 6;
  return 8;
}

/**
 * Kıdem tazminatına hak kazanılır mı.
 *
 * İSTİFA KIDEM KAZANDIRMAZ — ama askerlik, evlilik (kadın işçi, 1 yıl
 * içinde), emeklilik ve işçinin haklı feshi istisnadır. Bu istisnaları
 * bilmeyen bir sistem, hakkı olan çalışana "hakkın yok" der.
 */
export function earnsSeverance(reason: TerminationReason, seniorityYears: number): boolean {
  if (seniorityYears < 1) return false;
  switch (reason) {
    case "isci_istifasi":
    case "isveren_hakli_fesih":
      return false;
    default:
      return true;
  }
}

/** İhbar tazminatı işveren tarafından ödenir mi. */
export function employerOwesNotice(reason: TerminationReason): boolean {
  // Haklı nedenle derhal fesihte ihbar yoktur; istifada işçi öder.
  return reason === "isveren_feshi" || reason === "belirli_sure_bitimi";
}

export interface TerminationInput {
  readonly hiredAt: Date;
  readonly terminatedAt: Date;
  readonly reason: TerminationReason;
  /**
   * Giydirilmiş brüt günlük ücret: çıplak ücrete yol, yemek, ikramiye
   * gibi süreklilik arz eden ödemeler eklenmiş hâli.
   * BİLİNMİYORSA null — çıplak ücretle hesaplamak eksik ödemeye yol açar.
   */
  readonly dailyGrossWage: number | null;
  /** Yıllık kıdem tazminatı tavanı (dönemsel, mevzuatla belirlenir). */
  readonly severanceCeilingPerYear: number | null;
  /** Kullanılmayan yıllık izin günü — ödenmesi zorunludur. */
  readonly unusedLeaveDays: number;
}

export interface TerminationDraft {
  readonly seniorityYears: number;
  readonly seniorityMonths: number;
  readonly earnsSeverance: boolean;
  readonly severanceGross: number | null;
  readonly severanceCapped: boolean;
  readonly noticeWeeks: number;
  readonly employerOwesNotice: boolean;
  readonly noticeGross: number | null;
  readonly unusedLeaveGross: number | null;
  readonly totalGross: number | null;
  readonly unknowns: readonly string[];
  readonly legalBasis: readonly string[];
}

const DAY_MS = 86_400_000;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * İşten çıkış taslağı.
 *
 * ÜCRET BİLİNMİYORSA TUTAR HESAPLANMAZ. Sıfır yazılsaydı bordroya sıfır
 * geçer ve çalışan hakkını alamazdı; "bilinmiyor" demek, İK'nın bakmasını
 * sağlayan tek yoldur.
 */
export function draftTermination(input: TerminationInput): TerminationDraft {
  if (input.terminatedAt < input.hiredAt) {
    throw new TerminationError("Çıkış tarihi işe giriş tarihinden önce olamaz.");
  }

  const unknowns: string[] = [];
  const legalBasis: string[] = [];

  const years = completedYears(input.hiredAt, input.terminatedAt);
  const totalDays = Math.floor(
    (input.terminatedAt.getTime() - input.hiredAt.getTime()) / DAY_MS,
  );
  const months = Math.floor(totalDays / 30.4375);

  const earns = earnsSeverance(input.reason, years);
  legalBasis.push(
    earns
      ? `Kıdem tazminatı: 1475 sayılı Kanun md. 14 — her tam yıl için ${SEVERANCE_DAYS_PER_YEAR} gün.`
      : years < 1
        ? "Kıdem tazminatı: bir yılı doldurmayan çalışan hak kazanmaz (1475 md. 14)."
        : `Kıdem tazminatı: 1475 md. 14 — "${input.reason}" sebebiyle hak doğmaz. ` +
          `Çalışan itiraz ederse dayanak bu maddedir.`,
  );

  const weeks = noticeWeeks(months);
  const owesNotice = employerOwesNotice(input.reason);
  legalBasis.push(
    owesNotice
      ? `İhbar tazminatı: 4857 md. 17 — ${months} aylık kıdem için ${weeks} hafta.`
      : `İhbar tazminatı: 4857 md. 17 — "${input.reason}" sebebiyle işveren ödemez.`,
  );

  if (input.dailyGrossWage === null) {
    unknowns.push(
      "Giydirilmiş brüt günlük ücret bilinmiyor; tazminat tutarları HESAPLANAMADI. " +
        "Çıplak ücretle hesaplamak eksik ödemeye ve faizli davaya yol açar.",
    );
    return {
      seniorityYears: years,
      seniorityMonths: months,
      earnsSeverance: earns,
      severanceGross: null,
      severanceCapped: false,
      noticeWeeks: weeks,
      employerOwesNotice: owesNotice,
      noticeGross: null,
      unusedLeaveGross: null,
      totalGross: null,
      unknowns,
      legalBasis,
    };
  }

  // KIDEM: tam yıllar + artan süre orantılı.
  let severance: number | null = null;
  let capped = false;
  if (earns) {
    const fractionalYears = totalDays / 365.25;
    const raw = fractionalYears * SEVERANCE_DAYS_PER_YEAR * input.dailyGrossWage;

    if (input.severanceCeilingPerYear === null) {
      unknowns.push(
        "Kıdem tazminatı TAVANI girilmemiş; tutar tavansız hesaplandı. Yüksek " +
          "ücretlilerde tavansız hesap kat kat fazla çıkar ve fazla ödenen geri alınamaz.",
      );
      severance = round2(raw);
    } else {
      const ceiling = fractionalYears * input.severanceCeilingPerYear;
      capped = raw > ceiling;
      severance = round2(Math.min(raw, ceiling));
    }
  }

  const notice = owesNotice ? round2(weeks * 7 * input.dailyGrossWage) : 0;

  // KULLANILMAYAN İZİN ÖDENMEK ZORUNDADIR (md. 59).
  const leave = round2(input.unusedLeaveDays * input.dailyGrossWage);
  if (input.unusedLeaveDays > 0) {
    legalBasis.push(
      `Kullanılmayan yıllık izin: 4857 md. 59 — ${input.unusedLeaveDays} gün ödenir.`,
    );
  }

  return {
    seniorityYears: years,
    seniorityMonths: months,
    earnsSeverance: earns,
    severanceGross: severance,
    severanceCapped: capped,
    noticeWeeks: weeks,
    employerOwesNotice: owesNotice,
    noticeGross: notice,
    unusedLeaveGross: leave,
    totalGross: round2((severance ?? 0) + notice + leave),
    unknowns,
    legalBasis,
  };
}
