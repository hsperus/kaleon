/**
 * Bordro hesabı.
 *
 * SAP'DE HCM AYRI BİR ÜRÜNDÜR ve Türkiye bordrosu için ayrıca
 * yerelleştirme paketi gerekir. Buradaki kurallar Türk mevzuatının
 * kendisidir ve hazır gelir.
 *
 * DÖRT KURAL, BORDRONUN TAMAMINI BELİRLER — ve dördü de yanlış
 * yapıldığında bordro "çalışır" ama yanlış maaş öder:
 *
 *  1. GELİR VERGİSİ KÜMÜLATİF MATRAH ÜZERİNDEN HESAPLANIR. Ayın
 *     vergisi = (yıl başından bu aya kadarki toplam vergi) − (geçen
 *     aya kadarki toplam vergi). Her ay bağımsız hesaplansaydı herkes
 *     yıl boyunca ilk dilimde (%15) kalır ve yıl sonunda devasa bir
 *     vergi farkı çıkardı.
 *
 *  2. SGK TAVANI YALNIZCA SGK'YA UYGULANIR. Tavanı aşan kazançtan
 *     prim kesilmez ama GELİR VERGİSİ KESİLİR. Tavan vergiye de
 *     uygulansaydı yüksek maaşlılar eksik vergilendirilirdi.
 *
 *  3. ASGARİ ÜCRET İSTİSNASI BİR İNDİRİM DEĞİL, TAVANDIR. Herkesin
 *     ücretinin asgari ücret kadarlık kısmı gelir ve damga vergisinden
 *     istisnadır; istisna tutarı, asgari ücretin O AY ödeyeceği
 *     vergiye eşittir ve hesaplanan vergiyi NEGATİFE düşüremez.
 *
 *  4. SGK TABANI ALTINDA KAZANÇ OLMAZ. Yarım gün çalışan ya da asgari
 *     ücretin altında ücret alan biri için bile prim, taban üzerinden
 *     hesaplanır.
 */

import {
  parametersFor,
  unverified,
  type PayrollParameters,
  type TaxBracket,
} from "./parameters.js";

export class PayrollError extends Error {
  readonly code = "payroll";
  constructor(message: string) {
    super(message);
    this.name = "PayrollError";
  }
}

export interface PayrollInput {
  /** Brüt aylık ücret. */
  readonly grossSalary: number;
  /** Bordro dönemi (ayın herhangi bir günü). */
  readonly period: Date;
  /**
   * Bu aydan ÖNCEKİ kümülatif gelir vergisi matrahı.
   *
   * Yılın ilk ayında 0. Yıl içinde işe girenlerde önceki işverenden
   * devir varsa o tutar; yoksa yine 0 — ama bu bir VARSAYIMDIR ve
   * sonuçta çekince olarak görünür.
   */
  readonly cumulativeBase: number;
  /** Ek kazançlar (prim, ikramiye) — SGK ve vergiye tabidir. */
  readonly bonus?: number;
  /**
   * Asgari ücret istisnasından yararlanır mı.
   *
   * Neredeyse herkes yararlanır; istisna 2022'de AGİ'nin yerine geldi
   * ve tüm ücretlileri kapsar. Emekli (SGDP) çalışanlarda ve bazı
   * istisnai durumlarda değişir.
   */
  readonly minimumWageExemption?: boolean;
}

export interface PayrollResult {
  readonly grossSalary: number;
  readonly bonus: number;
  readonly totalGross: number;
  /** SGK primine esas kazanç — taban ve tavan uygulanmış hâli. */
  readonly sgkBase: number;
  readonly employeeSgk: number;
  readonly employeeUnemployment: number;
  /** Gelir vergisi matrahı = brüt − SGK kesintileri. */
  readonly taxBase: number;
  readonly cumulativeBaseBefore: number;
  readonly cumulativeBaseAfter: number;
  /** İstisna öncesi hesaplanan gelir vergisi. */
  readonly grossIncomeTax: number;
  /** Asgari ücret gelir vergisi istisnası. */
  readonly incomeTaxExemption: number;
  readonly incomeTax: number;
  readonly grossStampDuty: number;
  readonly stampDutyExemption: number;
  readonly stampDuty: number;
  readonly totalDeductions: number;
  readonly netSalary: number;
  /** İşveren SGK ve işsizlik payı. */
  readonly employerSgk: number;
  readonly employerUnemployment: number;
  /** İşverene toplam maliyet. */
  readonly employerCost: number;
  /** Ay içinde geçilen en yüksek vergi dilimi (yüzde). */
  readonly marginalRate: number;
  /** Teyide muhtaç parametreler ve varsayımlar. */
  readonly caveats: readonly string[];
  readonly parameters: PayrollParameters;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Kümülatif matrah üzerinden toplam gelir vergisi.
 *
 * Dilimler KÜMÜLATİF matraha uygulanır: 500.000 TL matrahın tamamı
 * %20'den değil, ilk 190.000'i %15, kalanı %20'den vergilendirilir.
 */
export function taxOn(base: number, brackets: readonly TaxBracket[]): number {
  if (base <= 0) return 0;
  let tax = 0;
  let lower = 0;
  for (const b of brackets) {
    const upper = b.upTo ?? Infinity;
    if (base <= lower) break;
    const slice = Math.min(base, upper) - lower;
    tax += slice * b.rate;
    lower = upper;
  }
  return round2(tax);
}

/** Kümülatif matrahın hangi dilime denk geldiği (yüzde). */
export function marginalRateFor(base: number, brackets: readonly TaxBracket[]): number {
  let lower = 0;
  for (const b of brackets) {
    const upper = b.upTo ?? Infinity;
    if (base <= upper) return Math.round(b.rate * 100);
    lower = upper;
  }
  return Math.round((brackets[brackets.length - 1]?.rate ?? 0) * 100);
}

/**
 * Asgari ücretin o ayki gelir vergisi — istisnanın tavanı.
 *
 * İSTİSNA SABİT BİR TUTAR DEĞİLDİR. Asgari ücretlinin kümülatif
 * matrahı da yıl içinde büyür ve dilim atlar; istisna da onunla
 * birlikte değişir. Sabit bir tutar kullanılsaydı yılın ikinci
 * yarısında istisna eksik kalır ve herkesten fazla vergi kesilirdi.
 */
export function minimumWageTaxFor(
  monthIndex: number,
  p: PayrollParameters,
): { incomeTax: number; stampDuty: number } {
  const gross = p.minimumWage.value;
  const sgkBase = gross;
  const deductions =
    sgkBase * p.employeeSgkRate.value + sgkBase * p.employeeUnemploymentRate.value;
  const monthlyBase = gross - deductions;

  // Asgari ücretlinin bu aya kadarki kümülatif matrahı.
  const before = monthlyBase * monthIndex;
  const after = before + monthlyBase;
  const brackets = p.brackets.value;

  return {
    incomeTax: round2(taxOn(after, brackets) - taxOn(before, brackets)),
    stampDuty: round2(gross * p.stampDutyRate.value),
  };
}

/** Bir ayın bordrosunu hesaplar. */
export function calculate(input: PayrollInput): PayrollResult {
  if (input.grossSalary <= 0) {
    throw new PayrollError("Brüt ücret pozitif olmalıdır.");
  }
  if (input.cumulativeBase < 0) {
    throw new PayrollError("Kümülatif matrah negatif olamaz.");
  }

  const p = parametersFor(input.period);
  const bonus = input.bonus ?? 0;
  if (bonus < 0) throw new PayrollError("Ek kazanç negatif olamaz.");
  const totalGross = round2(input.grossSalary + bonus);

  // ── SGK matrahı: taban ve tavan arasına sıkıştırılır ──
  const sgkBase = round2(
    Math.min(Math.max(totalGross, p.sgkFloor.value), p.sgkCeiling.value),
  );
  const employeeSgk = round2(sgkBase * p.employeeSgkRate.value);
  const employeeUnemployment = round2(sgkBase * p.employeeUnemploymentRate.value);

  /*
   * ── Gelir vergisi matrahı ──
   *
   * TAVANI AŞAN KAZANÇ VERGİYE TABİDİR. Matrah, TOPLAM brütten SGK
   * kesintileri düşülerek bulunur; SGK matrahından değil. Tavanın
   * üstünde kalan kısım prime tabi değildir ama gelire dahildir.
   */
  /*
   * NEGATİF VERGİ MATRAHI DİYE BİR ŞEY YOKTUR.
   *
   * SGK primi TABAN üzerinden hesaplanır (asgari ücret). Brüt ücret
   * tabanın çok altındaysa — kısmi süreli çalışan, stajyer, ay
   * ortasında işe giren — kesinti brütü aşabilir ve matrah eksiye
   * düşer. Eksi matrah bir sonraki aya kümülatif olarak taşınırsa
   * hesap tümden çöker: duman testinde `plan_annual_payroll` tam
   * olarak böyle patladı.
   *
   * Matrah sıfırda durur. Aşan kesinti bir sonraki aya DEVRETMEZ:
   * devretseydi çalışanın gelecek aylardaki vergisi, geçmişte
   * ödediği primle azaltılmış olurdu ve bunun mevzuatta karşılığı yok.
   */
  const taxBase = Math.max(0, round2(totalGross - employeeSgk - employeeUnemployment));
  const before = round2(input.cumulativeBase);
  const after = round2(before + taxBase);

  const brackets = p.brackets.value;
  const grossIncomeTax = round2(taxOn(after, brackets) - taxOn(before, brackets));

  // ── Asgari ücret istisnası ──
  const exempt = input.minimumWageExemption ?? true;
  const monthIndex = input.period.getUTCMonth();
  const mw = minimumWageTaxFor(monthIndex, p);

  // İSTİSNA VERGİYİ NEGATİFE DÜŞÜREMEZ: asgari ücretin altında bir
  // matrahta istisna, hesaplanan vergiyle sınırlıdır.
  const incomeTaxExemption = exempt ? Math.min(mw.incomeTax, grossIncomeTax) : 0;
  const incomeTax = round2(grossIncomeTax - incomeTaxExemption);

  const grossStampDuty = round2(totalGross * p.stampDutyRate.value);
  const stampDutyExemption = exempt ? Math.min(mw.stampDuty, grossStampDuty) : 0;
  const stampDuty = round2(grossStampDuty - stampDutyExemption);

  const totalDeductions = round2(
    employeeSgk + employeeUnemployment + incomeTax + stampDuty,
  );
  const netSalary = round2(totalGross - totalDeductions);

  const employerSgk = round2(sgkBase * p.employerSgkRate.value);
  const employerUnemployment = round2(sgkBase * p.employerUnemploymentRate.value);
  const employerCost = round2(totalGross + employerSgk + employerUnemployment);

  const caveats: string[] = [...unverified(p)];
  if (input.cumulativeBase === 0 && monthIndex > 0) {
    // YIL ORTASINDA SIFIR KÜMÜLATİF ŞÜPHELİDİR: çalışan yıl içinde
    // işe girmişse doğru, girmemişse eksik vergi kesilir.
    caveats.push(
      `Kümülatif matrah sıfır alındı ama dönem ${monthIndex + 1}. ay. Çalışan yıl ` +
        `içinde işe girdiyse doğru; girmediyse önceki ayların matrahı eklenmeli, ` +
        `aksi hâlde gelir vergisi EKSİK kesilir.`,
    );
  }
  if (totalGross > p.sgkCeiling.value) {
    caveats.push(
      `Brüt ücret SGK tavanının (${p.sgkCeiling.value.toLocaleString("tr-TR")} TL) ` +
        `üzerinde; tavanı aşan kısımdan prim kesilmedi ama gelir vergisi kesildi.`,
    );
  }

  return {
    grossSalary: round2(input.grossSalary),
    bonus: round2(bonus),
    totalGross,
    sgkBase,
    employeeSgk,
    employeeUnemployment,
    taxBase,
    cumulativeBaseBefore: before,
    cumulativeBaseAfter: after,
    grossIncomeTax,
    incomeTaxExemption: round2(incomeTaxExemption),
    incomeTax,
    grossStampDuty,
    stampDutyExemption: round2(stampDutyExemption),
    stampDuty,
    totalDeductions,
    netSalary,
    employerSgk,
    employerUnemployment,
    employerCost,
    marginalRate: marginalRateFor(after, brackets),
    caveats,
    parameters: p,
  };
}

/**
 * Yıllık bordro planı — 12 ay, kümülatif matrah yürütülerek.
 *
 * TEK AYIN BORDROSU YETMEZ. "Bu çalışan bana yılda kaça mal oluyor"
 * sorusunun cevabı, dilim atlamaları yüzünden aylık tutarın 12 katı
 * DEĞİLDİR: net maaş yıl içinde düşer, işveren maliyeti sabit kalır.
 */
export function annualPlan(
  grossSalary: number,
  year: number,
  opts: { bonus?: readonly number[]; minimumWageExemption?: boolean } = {},
): readonly PayrollResult[] {
  const out: PayrollResult[] = [];
  let cumulative = 0;
  for (let m = 0; m < 12; m += 1) {
    const r = calculate({
      grossSalary,
      period: new Date(Date.UTC(year, m, 15)),
      cumulativeBase: cumulative,
      bonus: opts.bonus?.[m] ?? 0,
      ...(opts.minimumWageExemption !== undefined
        ? { minimumWageExemption: opts.minimumWageExemption }
        : {}),
    });
    cumulative = r.cumulativeBaseAfter;
    out.push(r);
  }
  return out;
}
