/**
 * Grafik geometrisi.
 *
 * REACT'TEN AYRI, SAF MANTIK. Bir grafikteki hata sessizdir: yanlış
 * ölçeklenmiş bir çubuk "kötü tasarım" gibi görünür, oysa yanlış bilgi
 * verir. Ölçek hesabı test edilebilir olmalı.
 *
 * BU DOSYADAKİ ÜÇ KURAL, GRAFİĞİN YALAN SÖYLEMESİNİ ENGELLER:
 *
 *  1. ÇUBUK GRAFİĞİN TABANI SIFIRDIR. Taban 900'den başlatılırsa 1000
 *     ile 950 arasındaki fark iki katmış gibi görünür. Gazetecilikte
 *     bu bir hile sayılır; bir ERP'de karar hatasıdır.
 *
 *  2. BİLİNMEYEN SIFIR DEĞİLDİR. Değeri olmayan nokta çizilmez ve
 *     çizgi orada KOPAR. Sıfır olarak çizilseydi "o ay satış olmadı"
 *     denmiş olurdu; oysa "o ayın verisi yok".
 *
 *  3. FARKLI BİRİMLER AYNI EKSENDE OLMAZ. TL ile EUR'yu ya da adet ile
 *     saati tek eksende toplamak, sayıların toplamı kadar anlamsızdır.
 *     Bu kontrol çağıranın sorumluluğundadır; `sameUnit` yardımcı
 *     olarak burada durur.
 */

/** Grafiğe girecek tek nokta. Değer null ise BİLİNMİYOR demektir. */
export interface Point {
  readonly label: string;
  readonly value: number | null;
}

export interface Scale {
  /** Eksenin alt ucu. */
  readonly min: number;
  /** Eksenin üst ucu. */
  readonly max: number;
  /** Çizilecek çizgi/etiket değerleri. */
  readonly ticks: readonly number[];
}

/**
 * "Güzel" eksen adımı: 1, 2, 2.5, 5, 10 katları.
 *
 * Ham aralığı beşe bölmek 173.4 gibi adımlar üretir ve eksen okunmaz
 * hâle gelir; okunmayan eksen olmayan eksendir.
 */
function niceStep(raw: number): number {
  if (raw <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  return step * mag;
}

/**
 * Değerlerden eksen ölçeği kurar.
 *
 * @param includeZero Çubuk grafikte ZORUNLU true; çizgi grafikte
 *   dalgalanmayı görmek için false olabilir.
 */
export function scaleFor(
  values: readonly (number | null)[],
  opts: { includeZero: boolean; tickCount?: number } = { includeZero: true },
): Scale {
  const known = values.filter((v): v is number => v !== null && Number.isFinite(v));
  const count = Math.max(2, opts.tickCount ?? 4);

  if (known.length === 0) return { min: 0, max: 1, ticks: [0, 1] };

  let lo = Math.min(...known);
  let hi = Math.max(...known);

  if (opts.includeZero) {
    lo = Math.min(lo, 0);
    hi = Math.max(hi, 0);
  }

  // Tüm değerler eşitse ölçek çökerdi (sıfıra bölme); yapay bir aralık açılır.
  if (lo === hi) {
    if (lo === 0) return { min: 0, max: 1, ticks: [0, 0.5, 1] };
    const pad = Math.abs(lo) * 0.5;
    lo -= pad;
    hi += pad;
  }

  const step = niceStep((hi - lo) / count);
  const min = Math.floor(lo / step) * step;
  const max = Math.ceil(hi / step) * step;

  const ticks: number[] = [];
  // Kayan nokta birikimini önlemek için adım sayısı üzerinden üretilir.
  const n = Math.round((max - min) / step);
  for (let i = 0; i <= n; i += 1) {
    ticks.push(Math.round((min + i * step) * 1e6) / 1e6);
  }
  return { min, max, ticks };
}

/** Değeri 0..1 aralığına indirger (eksen üzerindeki oran). */
export function ratio(value: number, scale: Scale): number {
  const span = scale.max - scale.min;
  if (span === 0) return 0;
  return (value - scale.min) / span;
}

export interface Bar {
  readonly label: string;
  readonly value: number;
  /** Çubuğun sol kenarı, yüzde. */
  readonly x: number;
  readonly width: number;
  /** Çubuğun üst kenarı, yüzde (0 = tepe). */
  readonly y: number;
  readonly height: number;
  /** Değer negatif mi — renk ve etiket yönü buna bakar. */
  readonly negative: boolean;
}

/**
 * Çubukların yerleşimi — yüzde cinsinden, ölçüden bağımsız.
 *
 * Piksel yerine yüzde: grafik kapsayıcısı ne kadar genişse o kadar
 * çizilir ve mobilde yeniden hesaplamaya gerek kalmaz.
 */
export function barLayout(
  points: readonly Point[],
  scale: Scale,
  gapRatio = 0.32,
): readonly Bar[] {
  const n = points.length;
  if (n === 0) return [];

  const slot = 100 / n;
  const width = slot * (1 - gapRatio);
  const zero = ratio(0, scale);

  const bars: Bar[] = [];
  points.forEach((p, i) => {
    // BİLİNMEYEN ÇİZİLMEZ. Sıfır yüksekliğinde bir çubuk "sıfır" der.
    if (p.value === null || !Number.isFinite(p.value)) return;
    const v = ratio(p.value, scale);
    const top = Math.max(v, zero);
    const bottom = Math.min(v, zero);
    bars.push({
      label: p.label,
      value: p.value,
      x: i * slot + (slot - width) / 2,
      width,
      // SVG'de y aşağı doğru büyür; oran yukarıdan ölçülür.
      y: (1 - top) * 100,
      height: (top - bottom) * 100,
      negative: p.value < 0,
    });
  });
  return bars;
}

/** Çizgi grafiğin kopmuş parçaları. */
export interface Segment {
  readonly points: readonly { x: number; y: number; label: string; value: number }[];
}

/**
 * Çizgi parçaları — bilinmeyen noktada KOPAR.
 *
 * Tek bir kesintisiz çizgi çizilseydi, veri olmayan ay komşularının
 * ortalamasıymış gibi görünürdü ve grafiğe bakan kişi orada bir ölçüm
 * olduğunu sanırdı.
 */
export function lineSegments(points: readonly Point[], scale: Scale): readonly Segment[] {
  const out: Segment[] = [];
  let cur: { x: number; y: number; label: string; value: number }[] = [];
  const n = points.length;
  const dx = n > 1 ? 100 / (n - 1) : 0;

  points.forEach((p, i) => {
    if (p.value === null || !Number.isFinite(p.value)) {
      if (cur.length > 0) out.push({ points: cur });
      cur = [];
      return;
    }
    cur.push({
      x: n > 1 ? i * dx : 50,
      y: (1 - ratio(p.value, scale)) * 100,
      label: p.label,
      value: p.value,
    });
  });
  if (cur.length > 0) out.push({ points: cur });
  return out;
}

export interface Slice {
  readonly label: string;
  readonly value: number;
  /** Toplam içindeki pay, 0..1. */
  readonly share: number;
  /** SVG yay komutu (yarıçap 1 birim çemberde). */
  readonly path: string;
}

/**
 * Halka dilimleri.
 *
 * NEGATİF DEĞER DİLİMLENMEZ. Pay grafiği "bütünün parçaları"nı
 * gösterir; negatif bir parça bütünün parçası değildir ve çizilirse
 * yüzdeler toplamı 100'ü geçer. Böyle bir veri geldiğinde boş döner —
 * yanlış bir grafik, grafik olmamasından kötüdür.
 */
export function donutSlices(points: readonly Point[], innerRatio = 0.62): readonly Slice[] {
  const known = points.filter(
    (p): p is { label: string; value: number } =>
      p.value !== null && Number.isFinite(p.value),
  );
  if (known.some((p) => p.value < 0)) return [];
  const total = known.reduce((s, p) => s + p.value, 0);
  if (total <= 0) return [];

  const out: Slice[] = [];
  let angle = -Math.PI / 2; // Saat 12'den başlar.

  for (const p of known) {
    const share = p.value / total;
    const sweep = share * Math.PI * 2;
    const end = angle + sweep;

    const x = (a: number, r: number): number => 50 + Math.cos(a) * 50 * r;
    const y = (a: number, r: number): number => 50 + Math.sin(a) * 50 * r;
    const large = sweep > Math.PI ? 1 : 0;

    // Tam daire tek yay ile çizilemez (başlangıç ve bitiş çakışır).
    const path =
      share >= 0.9999
        ? `M ${x(angle, 1)} ${y(angle, 1)} A 50 50 0 1 1 ${x(angle + Math.PI, 1)} ${y(angle + Math.PI, 1)} A 50 50 0 1 1 ${x(angle, 1)} ${y(angle, 1)} Z` +
          ` M ${x(angle, innerRatio)} ${y(angle, innerRatio)} A ${50 * innerRatio} ${50 * innerRatio} 0 1 0 ${x(angle + Math.PI, innerRatio)} ${y(angle + Math.PI, innerRatio)} A ${50 * innerRatio} ${50 * innerRatio} 0 1 0 ${x(angle, innerRatio)} ${y(angle, innerRatio)} Z`
        : [
            `M ${x(angle, 1)} ${y(angle, 1)}`,
            `A 50 50 0 ${large} 1 ${x(end, 1)} ${y(end, 1)}`,
            `L ${x(end, innerRatio)} ${y(end, innerRatio)}`,
            `A ${50 * innerRatio} ${50 * innerRatio} 0 ${large} 0 ${x(angle, innerRatio)} ${y(angle, innerRatio)}`,
            "Z",
          ].join(" ");

    out.push({ label: p.label, value: p.value, share, path });
    angle = end;
  }
  return out;
}

/**
 * İki değer kümesi aynı birimde mi.
 *
 * TL ile EUR'yu tek eksende çizmek, onları toplamak kadar yanlıştır.
 */
export function sameUnit(units: readonly (string | null)[]): boolean {
  const known = units.filter((u): u is string => u !== null && u.trim() !== "");
  return new Set(known.map((u) => u.trim().toLocaleUpperCase("tr"))).size <= 1;
}
