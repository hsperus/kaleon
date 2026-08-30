/**
 * Bordro parametreleri — sürümlü ve KAYNAKLI.
 *
 * BORDRO PARAMETRESİ SABİT DEĞİL, VERİDİR. Asgari ücret, vergi
 * dilimleri ve SGK tavanı her yıl (bazen yıl ortasında) değişir. Koda
 * gömülü bir oran, değiştiği gün sessizce yanlış bordro üretir ve bu
 * yanlış, çalışanın cebinden ya da işverenin cezasından çıkar.
 *
 * HER RAKAMIN KAYNAĞI YAZILI. Bu modülü yazarken üç ayrı kaynak
 * işveren prim oranı için üç farklı sayı verdi (%20,75 · %18,8 ·
 * %22,5) ve bir kaynak damga vergisini on kat yanlış yazdı (binde
 * 0,759). Kaynağı yazılı olmayan bir bordro parametresi, doğru olduğu
 * varsayılan bir tahmindir.
 *
 * DOĞRULANAMAYAN PARAMETRE UYDURULMAZ. `confidence` alanı "resmi"
 * değilse hesap yine yapılır ama sonuç ÇEKİNCELİ döner ve kullanıcı
 * neyin teyide muhtaç olduğunu görür.
 */

export interface TaxBracket {
  /** Bu dilimin üst sınırı; sonuncuda null (sınırsız). */
  readonly upTo: number | null;
  /** Oran, ondalık: 0.15 = %15. */
  readonly rate: number;
}

export type Confidence = "resmi" | "teyit_gerekli";

export interface Parameter<T> {
  readonly value: T;
  readonly source: string;
  readonly confidence: Confidence;
}

export interface PayrollParameters {
  readonly year: number;
  readonly validFrom: string;
  /** Brüt asgari ücret, aylık. */
  readonly minimumWage: Parameter<number>;
  /** SGK prime esas kazanç alt sınırı (taban). */
  readonly sgkFloor: Parameter<number>;
  /** SGK prime esas kazanç üst sınırı (tavan). */
  readonly sgkCeiling: Parameter<number>;
  /** Sigortalı (işçi) SGK primi oranı. */
  readonly employeeSgkRate: Parameter<number>;
  /** Sigortalı işsizlik sigortası oranı. */
  readonly employeeUnemploymentRate: Parameter<number>;
  /** İşveren SGK primi oranı — teşvik durumuna göre DEĞİŞİR. */
  readonly employerSgkRate: Parameter<number>;
  readonly employerUnemploymentRate: Parameter<number>;
  /** Damga vergisi oranı. */
  readonly stampDutyRate: Parameter<number>;
  /** Ücret gelirleri gelir vergisi tarifesi — KÜMÜLATİF matraha uygulanır. */
  readonly brackets: Parameter<readonly TaxBracket[]>;
  /** Kıdem tazminatı tavanı (dönem başına). */
  readonly severanceCap: Parameter<number>;
}

const GIB_2026 =
  "GİB, Gelir Vergisi Tarifesi 2026 (193 s. GVK md. 103) — resmi tarife metni";

/**
 * 2026 parametreleri.
 *
 * ÜCRET TARİFESİ AYRIDIR. GVK 103'te üçüncü ve dördüncü dilimlerin
 * sınırları ücret gelirlerinde farklıdır (1.500.000 ve 5.300.000);
 * ücret dışı gelirlerin tarifesi (1.000.000) buraya YAZILMAZ —
 * yazılsaydı orta gelirli her çalışan fazla vergilendirilirdi.
 */
export const PARAMETERS_2026: PayrollParameters = {
  year: 2026,
  validFrom: "2026-01-01",

  minimumWage: {
    value: 33_030,
    source: "2026 asgari ücret tespit komisyonu kararı; brüt aylık 33.030,00 TL",
    confidence: "resmi",
  },

  // SGK tabanı asgari ücrete eşittir; tavan 2026'da asgari ücretin
  // 9 katına çıkarıldı (önceki yıllarda 7,5 kat).
  sgkFloor: {
    value: 33_030,
    source: "SGK prime esas kazanç alt sınırı = brüt asgari ücret",
    confidence: "resmi",
  },
  sgkCeiling: {
    value: 297_270,
    source: "SGK prime esas kazanç üst sınırı = asgari ücret × 9 (2026)",
    confidence: "resmi",
  },

  employeeSgkRate: {
    value: 0.14,
    source:
      "Sigortalı payı %14 (MYÖ %9 + GSS %5). 33.030 × %15 toplam kesinti = " +
      "4.954,50 ve net 28.075,50 rakamıyla doğrulandı.",
    confidence: "resmi",
  },
  employeeUnemploymentRate: {
    value: 0.01,
    source: "Sigortalı işsizlik sigortası payı %1",
    confidence: "resmi",
  },

  /*
   * İŞVEREN ORANI TEYİDE MUHTAÇTIR — VE BU BİLEREK BÖYLE.
   *
   * Oran şirkete göre gerçekten değişir: 5 puanlık imalat indirimi,
   * kısa vadeli sigorta kolları için tehlike sınıfı, ve diğer
   * teşvikler. Kaynaklar da çelişiyor (%20,75 · %22,5 · %18,8).
   * Buradaki değer en sık verilen orandır ama HESABIN SONUCU
   * "teyit gerekli" olarak işaretlenir; şirket kendi oranını
   * tanımlayana kadar işveren maliyeti kesin sayılmaz.
   */
  employerSgkRate: {
    value: 0.2075,
    source:
      "İşveren payı %20,75 (indirimsiz). Teşvik ve tehlike sınıfına göre " +
      "değişir; şirketin kendi oranı tanımlanmalıdır.",
    confidence: "teyit_gerekli",
  },
  employerUnemploymentRate: {
    value: 0.02,
    source: "İşveren işsizlik sigortası payı %2",
    confidence: "resmi",
  },

  stampDutyRate: {
    value: 0.00759,
    source: "Damga Vergisi Kanunu (I) sayılı tablo — ücretlerde binde 7,59",
    confidence: "resmi",
  },

  brackets: {
    value: [
      { upTo: 190_000, rate: 0.15 },
      { upTo: 400_000, rate: 0.2 },
      // Ücret gelirlerinde üçüncü dilim 1.500.000'e kadar.
      { upTo: 1_500_000, rate: 0.27 },
      { upTo: 5_300_000, rate: 0.35 },
      { upTo: null, rate: 0.4 },
    ],
    source: GIB_2026,
    confidence: "resmi",
  },

  severanceCap: {
    value: 53_919.68,
    source: "Kıdem tazminatı tavanı, 01.01.2026 – 30.06.2026 dönemi",
    confidence: "resmi",
  },
};

const ALL: readonly PayrollParameters[] = [PARAMETERS_2026];

export class PayrollParameterError extends Error {
  readonly code = "payroll_parameter";
  constructor(message: string) {
    super(message);
    this.name = "PayrollParameterError";
  }
}

/**
 * Bir tarihe ait parametreler.
 *
 * TANIMSIZ YIL İÇİN HESAP YAPILMAZ. Geçen yılın oranlarıyla bu yılın
 * bordrosunu üretmek, sessizce yanlış bir bordro üretmektir; hata
 * vermek, yanlış maaş ödemekten iyidir.
 */
export function parametersFor(date: Date): PayrollParameters {
  const year = date.getUTCFullYear();
  const found = ALL.find((p) => p.year === year);
  if (!found) {
    throw new PayrollParameterError(
      `${year} yılı için bordro parametreleri tanımlı değil. Asgari ücret, ` +
        `vergi dilimleri ve SGK tavanı her yıl değişir; tanımlanmadan bordro ` +
        `hesaplanamaz.`,
    );
  }
  return found;
}

/** Teyide muhtaç parametrelerin listesi — sonuca çekince olarak eklenir. */
export function unverified(p: PayrollParameters): readonly string[] {
  const out: string[] = [];
  const check = (label: string, param: Parameter<unknown>): void => {
    if (param.confidence !== "resmi") out.push(`${label}: ${param.source}`);
  };
  check("İşveren SGK oranı", p.employerSgkRate);
  check("İşveren işsizlik oranı", p.employerUnemploymentRate);
  check("Damga vergisi oranı", p.stampDutyRate);
  check("Gelir vergisi tarifesi", p.brackets);
  check("SGK tavanı", p.sgkCeiling);
  return out;
}
