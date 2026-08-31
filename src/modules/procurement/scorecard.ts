/**
 * Tedarikçi karnesi.
 *
 * TEKLİF TOPLAMA VARDI, SEÇİMİN SONUCU ÖLÇÜLMÜYORDU. Zamanında
 * gelmeyen, eksik gönderen, sonradan zam yapan tedarikçi bir sonraki
 * turda aynı puanla yarışıyordu — ve en ucuz teklif her seferinde
 * kazanıyordu, gerçekte en pahalısı olsa bile.
 *
 * ─────────────────────────────────────────────────────────────────
 *
 * PUAN HESAPLANIR, ELLE GİRİLMEZ.
 *
 * Elle girilen bir tedarikçi puanı, puanı girenin o günkü ruh hâlini
 * ölçer. Termin ve miktar performansı zaten mal kabul kayıtlarında
 * duruyor; oradan türetilmeli.
 *
 * AZ VERİYLE PUAN VERİLMEZ.
 *
 * İki teslimatı olan bir tedarikçiye "%100 termin" demek matematiksel
 * olarak doğru, pratikte yanıltıcıdır: bir sonraki teslimat geciktiğinde
 * puan %66'ya düşer ve kimse neden bu kadar oynadığını anlamaz. Eşiğin
 * altında puan DEĞİL, "yetersiz veri" döner.
 */

function yuzde(pay: number, payda: number): number {
  return payda === 0 ? 0 : Math.round((pay / payda) * 1000) / 10;
}

/** Bu sayıdan az teslimatta puan üretilmez. */
export const ASGARI_TESLIMAT = 3;

/** Termin toleransı: bu kadar gün gecikme "zamanında" sayılır. */
export const TERMIN_TOLERANSI = 2;

export interface DeliveryRecord {
  readonly poId: string;
  readonly itemId: string;
  /** Tedarikçinin verdiği termin. null = termin alınmamış. */
  readonly promisedDate: Date | null;
  readonly receivedAt: Date;
  readonly orderedQuantity: number;
  readonly receivedQuantity: number;
}

export interface PriceChange {
  readonly itemId: string;
  readonly previousPrice: number;
  readonly currentPrice: number;
}

export interface Scorecard {
  readonly partnerId: string;
  readonly partnerName: string;
  readonly deliveryCount: number;
  /** null = yetersiz veri. */
  readonly onTimePercent: number | null;
  readonly inFullPercent: number | null;
  /** Termini olmayan teslimat sayısı — ölçülemeyen kısım. */
  readonly withoutPromise: number;
  /** Ortalama gecikme günü (yalnızca gecikenler). */
  readonly averageDelayDays: number | null;
  /** Ortalama fiyat artışı yüzdesi; ölçülemiyorsa null. */
  readonly priceChangePercent: number | null;
  /** 0–100 birleşik puan; yetersiz veride null. */
  readonly score: number | null;
  readonly verdict: string;
}

const GUN = 86_400_000;

function gunFarki(a: Date, b: Date): number {
  const g = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return Math.round((g(a) - g(b)) / GUN);
}

/**
 * Bir tedarikçinin karnesi.
 *
 * ÜÇ ÖLÇÜ: zamanında mı geldi, tam mı geldi, fiyatı nasıl değişti.
 * Kalite dördüncü ölçü olabilirdi ve bilerek DIŞARIDA: uygunsuzluk
 * kaydı henüz her tedarikçi için tutulmuyor ve eksik veriden puan
 * üretmek, puanı olmayan tedarikçiyi kayıran bir sıralama doğurur.
 */
export function buildScorecard(
  partnerId: string,
  partnerName: string,
  deliveries: readonly DeliveryRecord[],
  priceChanges: readonly PriceChange[],
): Scorecard {
  const terminli = deliveries.filter((d) => d.promisedDate !== null);
  const terminsiz = deliveries.length - terminli.length;

  if (deliveries.length < ASGARI_TESLIMAT) {
    return {
      partnerId,
      partnerName,
      deliveryCount: deliveries.length,
      onTimePercent: null,
      inFullPercent: null,
      withoutPromise: terminsiz,
      averageDelayDays: null,
      priceChangePercent: null,
      score: null,
      verdict:
        `Yetersiz veri: ${deliveries.length} teslimat. Puan için en az ` +
        `${ASGARI_TESLIMAT} teslimat gerekir — iki teslimatla "%100 termin" ` +
        `demek, üçüncüsü gecikince puanın üçte bir düşmesi demektir.`,
    };
  }

  /*
   * TERMİNİ OLMAYAN TESLİMAT "ZAMANINDA" SAYILMAZ, HİÇ SAYILMAZ.
   *
   * Zamanında saymak, termin vermeyen tedarikçiyi ödüllendirirdi;
   * geç saymak cezalandırırdı. İkisi de veriyi olmadığı bir şey
   * hakkında konuşturmak olurdu — paydadan çıkarılıyor ve sayısı
   * ayrıca bildiriliyor.
   */
  const zamaninda = terminli.filter(
    (d) => gunFarki(d.receivedAt, d.promisedDate!) <= TERMIN_TOLERANSI,
  ).length;
  const terminPuani = terminli.length === 0 ? null : yuzde(zamaninda, terminli.length);

  const gecikenler = terminli
    .map((d) => gunFarki(d.receivedAt, d.promisedDate!))
    .filter((g) => g > TERMIN_TOLERANSI);
  const ortGecikme =
    gecikenler.length === 0
      ? null
      : Math.round((gecikenler.reduce((s, g) => s + g, 0) / gecikenler.length) * 10) / 10;

  // Tam gelen: sipariş miktarının tamamı (ya da fazlası) teslim alınmış.
  const tam = deliveries.filter((d) => d.receivedQuantity >= d.orderedQuantity).length;
  const miktarPuani = yuzde(tam, deliveries.length);

  const artislar = priceChanges
    .filter((p) => p.previousPrice > 0)
    .map((p) => ((p.currentPrice - p.previousPrice) / p.previousPrice) * 100);
  const ortArtis =
    artislar.length === 0
      ? null
      : Math.round((artislar.reduce((s, a) => s + a, 0) / artislar.length) * 10) / 10;

  /*
   * BİRLEŞİK PUAN: termin %45, miktar %45, fiyat %10.
   *
   * Fiyatın ağırlığı düşük, kasıtlı. Fiyat zaten teklif aşamasında
   * karşılaştırılıyor ve orada kararı belirleyen ana ölçü. Karne,
   * teklifin GÖREMEDİĞİ şeyi ölçmek için var: sözünü tutuyor mu.
   */
  const fiyatPuani = ortArtis === null ? 100 : Math.max(0, 100 - Math.max(0, ortArtis) * 2);
  const puan = Math.round(
    (terminPuani ?? miktarPuani) * 0.45 + miktarPuani * 0.45 + fiyatPuani * 0.1,
  );

  const hukum =
    puan >= 85
      ? "İyi: sözünü tutuyor."
      : puan >= 65
        ? "Orta: gecikme ya da eksik sevkiyat var, izlenmeli."
        : "Zayıf: termin ve miktar performansı düşük; alternatif tedarikçi aranmalı.";

  return {
    partnerId,
    partnerName,
    deliveryCount: deliveries.length,
    onTimePercent: terminPuani,
    inFullPercent: miktarPuani,
    withoutPromise: terminsiz,
    averageDelayDays: ortGecikme,
    priceChangePercent: ortArtis,
    score: puan,
    verdict:
      hukum +
      (terminsiz > 0
        ? ` ${terminsiz} teslimatta termin alınmamış; termin performansı bu ` +
          `teslimatlar HARİÇ hesaplandı.`
        : ""),
  };
}

/**
 * Sözleşme tavanı kontrolü.
 *
 * TAVAN AŞILAMAZ AMA AŞIM SESSİZ DE KALAMAZ. Sözleşmenin anlamı,
 * tarafların üzerinde anlaştığı sınırdır; onu aşan bir çekiliş yeni
 * bir anlaşma gerektirir.
 */
export interface ContractUsage {
  readonly usedAmount: number;
  readonly usedQuantity: number;
  readonly ceilingAmount: number | null;
  readonly ceilingQuantity: number | null;
  readonly remainingAmount: number | null;
  readonly remainingQuantity: number | null;
}

export class ContractError extends Error {
  readonly code = "contract";
  constructor(message: string) {
    super(message);
    this.name = "ContractError";
  }
}

export function assertWithinCeiling(
  usage: ContractUsage,
  addAmount: number,
  addQuantity: number,
  documentNo: string,
): void {
  if (usage.ceilingAmount !== null && usage.usedAmount + addAmount > usage.ceilingAmount) {
    throw new ContractError(
      `${documentNo} sözleşmesinin tutar tavanı aşılıyor: kullanılan ` +
        `${usage.usedAmount}, bu çekilişle ${usage.usedAmount + addAmount}, tavan ` +
        `${usage.ceilingAmount}. Tavanı aşan bir çekiliş yeni bir anlaşma gerektirir.`,
    );
  }
  if (usage.ceilingQuantity !== null && usage.usedQuantity + addQuantity > usage.ceilingQuantity) {
    throw new ContractError(
      `${documentNo} sözleşmesinin miktar tavanı aşılıyor: kullanılan ` +
        `${usage.usedQuantity}, bu çekilişle ${usage.usedQuantity + addQuantity}, tavan ` +
        `${usage.ceilingQuantity}.`,
    );
  }
}
