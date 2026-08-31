/**
 * Muayene değerlendirmesi.
 *
 * SİSTEMDE "GEÇTİ/KALDI" VARDI, "NE ÖLÇÜLDÜ" YOKTU. Kalite kapısı bir
 * karar kaydediyordu ama o kararın dayanağını değil. Müşteri sertifika
 * istediğinde ya da bir parti geri çağrıldığında elde veri kalmıyordu.
 *
 * ─────────────────────────────────────────────────────────────────
 *
 * KARAR ÖLÇÜMDEN TÜRETİLİR, ELLE GİRİLMEZ.
 *
 * Muayeneyi yapan kişi değerleri yazar; "geçti mi" sorusunun cevabını
 * tolerans belirler. Elle girilebilseydi, sapmış bir ölçümün yanına
 * "geçti" yazmak mümkün olurdu ve kontrol planının hiçbir anlamı
 * kalmazdı.
 *
 * KRİTİK ÖZELLİKTE ŞARTLI KABUL YOKTUR. Normal bir özellik sapınca
 * "şartlı kabul" mümkündür — müşteri bilgilendirilir, iskonto
 * konuşulur. Kritik bir özellik (emniyet, mevzuat) sapınca böyle bir
 * kapı olmamalı; olsaydı en tehlikeli sapma en kolay aşılan olurdu.
 */

export class InspectionError extends Error {
  readonly code = "inspection";
  constructor(message: string) {
    super(message);
    this.name = "InspectionError";
  }
}

export interface Characteristic {
  readonly id: string;
  readonly seq: number;
  readonly name: string;
  /** numeric | attribute */
  readonly kind: string;
  readonly uom: string | null;
  readonly lowerLimit: number | null;
  readonly upperLimit: number | null;
  readonly isCritical: boolean;
}

export interface Measurement {
  readonly characteristicId: string;
  /** Sayısal özellikte ölçülen değer; nitelikte null. */
  readonly measured: number | null;
  /** Nitelik özelliğinde uygunluk; sayısalda YOK SAYILIR ve hesaplanır. */
  readonly conforms: boolean | null;
  readonly note: string | null;
}

export interface EvaluatedResult {
  readonly characteristicId: string;
  readonly name: string;
  readonly measured: number | null;
  readonly conforms: boolean;
  readonly isCritical: boolean;
  /** Neden uygun değil — kullanıcıya gösterilecek cümle. */
  readonly deviation: string | null;
}

export type LotResult = "passed" | "failed" | "conditional";

export interface Evaluation {
  readonly results: readonly EvaluatedResult[];
  readonly result: LotResult;
  readonly failedCount: number;
  readonly criticalFailedCount: number;
  readonly summary: string;
}

/** Ölçüm toleransa uyuyor mu, uymuyorsa nasıl sapıyor. */
function degerlendir(c: Characteristic, m: Measurement): { conforms: boolean; deviation: string | null } {
  if (c.kind === "attribute") {
    /*
     * NİTELİK ÖZELLİĞİNDE KARAR İNSANDA — ama boş bırakılamaz.
     *
     * "Yüzeyde çizik var mı" sorusunun cevabı ölçülemez, bakılır.
     * Cevapsız bırakılırsa muayene tamamlanmamış demektir.
     */
    if (m.conforms === null) {
      throw new InspectionError(
        `"${c.name}" nitelik özelliğidir ve uygun olup olmadığı yazılmalıdır. ` +
          `Ölçülemez ama bakılır; boş bırakılan bir özellik, yapılmamış bir ` +
          `muayenedir.`,
      );
    }
    return {
      conforms: m.conforms,
      deviation: m.conforms ? null : `${c.name}: uygun değil${m.note ? ` — ${m.note}` : ""}`,
    };
  }

  if (m.measured === null) {
    throw new InspectionError(
      `"${c.name}" sayısal bir özelliktir ve ölçülen değer yazılmalıdır. ` +
        `Değer olmadan "geçti" demek, kontrol planını anlamsız kılar.`,
    );
  }

  const birim = c.uom ? ` ${c.uom}` : "";
  if (c.lowerLimit !== null && m.measured < c.lowerLimit) {
    return {
      conforms: false,
      deviation:
        `${c.name}: ölçülen ${m.measured}${birim}, alt sınır ${c.lowerLimit}${birim} ` +
        `(${Math.round((c.lowerLimit - m.measured) * 1e6) / 1e6}${birim} altında)`,
    };
  }
  if (c.upperLimit !== null && m.measured > c.upperLimit) {
    return {
      conforms: false,
      deviation:
        `${c.name}: ölçülen ${m.measured}${birim}, üst sınır ${c.upperLimit}${birim} ` +
        `(${Math.round((m.measured - c.upperLimit) * 1e6) / 1e6}${birim} üstünde)`,
    };
  }
  return { conforms: true, deviation: null };
}

/**
 * Bir muayenenin tamamını değerlendirir.
 *
 * EKSİK ÖLÇÜM MUAYENEYİ TAMAMLAMAZ. Planda beş özellik varsa beşi de
 * ölçülmeli; dördünü ölçüp "geçti" demek, ölçülmeyen özelliğin
 * sapmadığını varsaymaktır.
 */
export function evaluateLot(
  characteristics: readonly Characteristic[],
  measurements: readonly Measurement[],
): Evaluation {
  if (characteristics.length === 0) {
    throw new InspectionError(
      "Kontrol planında hiç özellik yok. Boş bir plan hiçbir şey denetlemez.",
    );
  }

  const olculen = new Map(measurements.map((m) => [m.characteristicId, m]));
  const eksik = characteristics.filter((c) => !olculen.has(c.id));
  if (eksik.length > 0) {
    throw new InspectionError(
      `Şu özellikler ölçülmedi: ${eksik.map((c) => c.name).join(", ")}. ` +
        `Ölçülmeyen bir özelliğin sapmadığını varsaymak, muayenenin kendisini ` +
        `boşa çıkarır.`,
    );
  }

  const results: EvaluatedResult[] = characteristics
    .slice()
    .sort((a, b) => a.seq - b.seq)
    .map((c) => {
      const m = olculen.get(c.id)!;
      const { conforms, deviation } = degerlendir(c, m);
      return {
        characteristicId: c.id,
        name: c.name,
        measured: m.measured,
        conforms,
        isCritical: c.isCritical,
        deviation,
      };
    });

  const kalan = results.filter((r) => !r.conforms);
  const kritikKalan = kalan.filter((r) => r.isCritical);

  /*
   * ÜÇ SONUÇ, İKİ DEĞİL.
   *
   * "Şartlı kabul" gerçek bir karardır ve kaydedilmelidir: parti
   * kullanılıyor ama sapmayla, ve müşteri bunu biliyor. İkili bir
   * sistemde bu durum ya "geçti" diye kaydedilir (sapma kaybolur) ya
   * da "kaldı" diye kaydedilir (parti kullanılmasına rağmen).
   */
  const result: LotResult =
    kritikKalan.length > 0 ? "failed" : kalan.length === 0 ? "passed" : "conditional";

  const summary =
    result === "passed"
      ? `${results.length} özelliğin tamamı tolerans içinde.`
      : result === "failed"
        ? `KRİTİK sapma: ${kritikKalan.map((r) => r.name).join(", ")}. Parti reddedilir; ` +
          `kritik özellikte şartlı kabul yoktur.`
        : `${kalan.length} özellik tolerans dışı ama hiçbiri kritik değil: ` +
          `${kalan.map((r) => r.name).join(", ")}. Şartlı kabul mümkün — karar ` +
          `müşteriye bildirilmeyi gerektirir.`;

  return {
    results,
    result,
    failedCount: kalan.length,
    criticalFailedCount: kritikKalan.length,
    summary,
  };
}
