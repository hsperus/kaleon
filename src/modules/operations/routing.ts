/**
 * Rota ve standart maliyet.
 *
 * ROTA, İŞ EMRİNİN DOĞRUSUDUR.
 *
 * Operasyonlar iş emrine gömülüydü: her yeni iş emrinde aynı dizi
 * elle yazılıyordu. Bir operasyonun süresi yanlış girildiğinde
 * yalnızca o iş emri yanlış oluyordu ve kimse fark etmiyordu, çünkü
 * karşılaştırılacak bir "doğru" yoktu. Rota o doğruyu tanımlar;
 * sapma ancak ondan sonra ölçülebilir.
 *
 * ─────────────────────────────────────────────────────────────────
 *
 * HAZIRLIK PARTİ BAŞINA, İŞLEME ADET BAŞINA.
 *
 * Tek bir "süre" alanıyla 10 adetlik parti ile 1000 adetlik parti
 * aynı birim süreyle hesaplanırdı. Oysa hazırlık parti başına bir kez,
 * işleme her adet için harcanır — küçük partide birim maliyeti
 * belirleyen şey hazırlıktır ve bu, fiyat vermeyi doğrudan etkiler.
 */

function kurusla(n: number): number {
  return Math.round(n * 100) / 100;
}

export class RoutingError extends Error {
  readonly code = "routing";
  constructor(message: string) {
    super(message);
    this.name = "RoutingError";
  }
}

export interface Operation {
  readonly seq: number;
  readonly workCenterId: string;
  readonly description: string;
  readonly setupMinutes: number;
  readonly runMinutesPerUnit: number;
}

export interface OperationLoad {
  readonly seq: number;
  readonly workCenterId: string;
  readonly description: string;
  readonly setupMinutes: number;
  readonly runMinutes: number;
  readonly totalMinutes: number;
  /** Bu operasyonun toplam süredeki payı, yüzde. */
  readonly sharePercent: number;
}

export interface RoutingLoad {
  readonly quantity: number;
  readonly operations: readonly OperationLoad[];
  readonly setupTotal: number;
  readonly runTotal: number;
  readonly totalMinutes: number;
  /** Birim başına dakika — parti büyüklüğüne göre DEĞİŞİR. */
  readonly minutesPerUnit: number;
  /** Süreyi belirleyen operasyon — darboğaz. */
  readonly bottleneck: string;
}

/**
 * Bir parti için rota yükü.
 *
 * BİRİM SÜRE PARTİ BÜYÜKLÜĞÜNE GÖRE DEĞİŞİR ve bu değişimi görmek,
 * "neden küçük siparişe daha pahalı fiyat veriyoruz" sorusunun
 * cevabıdır.
 */
export function computeLoad(operations: readonly Operation[], quantity: number): RoutingLoad {
  if (operations.length === 0) {
    throw new RoutingError("Rotada hiç operasyon yok; boş bir rota hiçbir şey üretmez.");
  }
  if (!(quantity > 0)) {
    throw new RoutingError("Parti miktarı sıfırdan büyük olmalı.");
  }

  const satirlar = [...operations]
    .sort((a, b) => a.seq - b.seq)
    .map((o) => {
      const isleme = kurusla(o.runMinutesPerUnit * quantity);
      return {
        seq: o.seq,
        workCenterId: o.workCenterId,
        description: o.description,
        setupMinutes: kurusla(o.setupMinutes),
        runMinutes: isleme,
        totalMinutes: kurusla(o.setupMinutes + isleme),
        sharePercent: 0,
      };
    });

  const toplam = kurusla(satirlar.reduce((s, o) => s + o.totalMinutes, 0));
  const paylı = satirlar.map((o) => ({
    ...o,
    sharePercent: toplam === 0 ? 0 : Math.round((o.totalMinutes / toplam) * 1000) / 10,
  }));

  const darbogaz = paylı.reduce((a, b) => (b.totalMinutes > a.totalMinutes ? b : a));

  return {
    quantity,
    operations: paylı,
    setupTotal: kurusla(satirlar.reduce((s, o) => s + o.setupMinutes, 0)),
    runTotal: kurusla(satirlar.reduce((s, o) => s + o.runMinutes, 0)),
    totalMinutes: toplam,
    minutesPerUnit: Math.round((toplam / quantity) * 10000) / 10000,
    bottleneck: darbogaz.workCenterId,
  };
}

export interface CostComponents {
  readonly material: number;
  readonly labor: number;
  readonly overhead: number;
}

export interface CostVariance {
  readonly component: "material" | "labor" | "overhead";
  readonly label: string;
  readonly standard: number;
  readonly actual: number;
  /** Gerçekleşen − standart. Pozitif = fazla harcandı. */
  readonly variance: number;
  /** null = standart sıfır, oran tanımsız. */
  readonly variancePercent: number | null;
}

export interface VarianceReport {
  readonly itemId: string;
  readonly quantity: number;
  readonly standardTotal: number;
  readonly actualTotal: number;
  readonly totalVariance: number;
  readonly components: readonly CostVariance[];
  /** En büyük sapmanın bileşeni — nereye bakılacağı. */
  readonly worstComponent: string | null;
  readonly summary: string;
}

const ETIKET = {
  material: "Malzeme",
  labor: "İşçilik",
  overhead: "Genel üretim gideri",
} as const;

/**
 * Standart–gerçekleşen sapma analizi.
 *
 * ÜÇ BİLEŞEN AYRI RAPORLANIR. Toplam sapmayı bilmek "bir sorun var"
 * demektir; hangi bileşende sapıldığını bilmek "nereye bakılacağını"
 * söyler. Malzeme sapması satın almanın işi, işçilik sapması üretimin.
 * Tek sayıya indirgemek, iki farklı bölümün sorumluluğunu birbirine
 * karıştırır.
 */
export function analyzeVariance(
  itemId: string,
  quantity: number,
  standardPerUnit: CostComponents,
  actualTotal: CostComponents,
): VarianceReport {
  if (!(quantity > 0)) {
    throw new RoutingError("Miktar sıfırdan büyük olmalı; sıfır adette sapma tanımsızdır.");
  }

  const bilesenler: CostVariance[] = (["material", "labor", "overhead"] as const).map((k) => {
    const std = kurusla(standardPerUnit[k] * quantity);
    const ger = kurusla(actualTotal[k]);
    return {
      component: k,
      label: ETIKET[k],
      standard: std,
      actual: ger,
      variance: kurusla(ger - std),
      variancePercent: std === 0 ? null : Math.round(((ger - std) / std) * 1000) / 10,
    };
  });

  const stdToplam = kurusla(bilesenler.reduce((s, c) => s + c.standard, 0));
  const gerToplam = kurusla(bilesenler.reduce((s, c) => s + c.actual, 0));
  const sapma = kurusla(gerToplam - stdToplam);

  // En kötü: mutlak sapması en büyük olan. Yüzdeye göre seçmek,
  // küçük bir kalemdeki %300'ü büyük bir kalemdeki %5'in önüne
  // koyar — oysa paraya dönüşen ikincisidir.
  const enKotu = bilesenler.reduce((a, b) =>
    Math.abs(b.variance) > Math.abs(a.variance) ? b : a,
  );

  const summary =
    Math.abs(sapma) < 0.005
      ? "Gerçekleşen maliyet standartla birebir aynı."
      : sapma > 0
        ? `${kurusla(sapma)} FAZLA harcandı (%${
            stdToplam === 0 ? "—" : Math.round((sapma / stdToplam) * 1000) / 10
          }). En büyük sapma: ${enKotu.label}.`
        : `${kurusla(-sapma)} TASARRUF edildi. En büyük fark: ${enKotu.label}.`;

  return {
    itemId,
    quantity,
    standardTotal: stdToplam,
    actualTotal: gerToplam,
    totalVariance: sapma,
    components: bilesenler,
    worstComponent: Math.abs(enKotu.variance) < 0.005 ? null : enKotu.label,
    summary,
  };
}
