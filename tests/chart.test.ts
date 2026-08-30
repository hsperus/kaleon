/**
 * Grafik geometrisi.
 *
 * BURADAKİ HATA "KÖTÜ TASARIM" GİBİ GÖRÜNÜR, OYSA YANLIŞ BİLGİDİR.
 * Tabanı sıfırdan başlamayan bir çubuk grafik, %5'lik bir farkı iki kat
 * gibi gösterir; bilinmeyeni sıfır çizen bir çizgi, olmayan bir ölçümü
 * varmış gibi gösterir. Testler bu üç yalanı hedefliyor.
 */

import { describe, expect, it } from "vitest";
import {
  barLayout,
  donutSlices,
  lineSegments,
  ratio,
  sameUnit,
  scaleFor,
  type Point,
} from "../src/ui/chart.js";

const p = (label: string, value: number | null): Point => ({ label, value });

describe("eksen ölçeği", () => {
  it("ÇUBUK GRAFİĞİN TABANI SIFIRDIR", () => {
    // 950 ile 1000 arasındaki fark, taban 900 olsaydı iki kat görünürdü.
    const s = scaleFor([950, 1000], { includeZero: true });
    expect(s.min).toBe(0);
    expect(s.max).toBeGreaterThanOrEqual(1000);
  });

  it("çizgi grafikte taban serbest bırakılabilir", () => {
    // Dalgalanmayı görmek için; çizgide oran yanılgısı yoktur.
    const s = scaleFor([950, 1000], { includeZero: false });
    expect(s.min).toBeGreaterThan(0);
  });

  it("okunabilir adımlar üretir", () => {
    const s = scaleFor([0, 173.4]);
    // 173.4/4 = 43.35 → yuvarlanmış adım.
    const step = s.ticks[1]! - s.ticks[0]!;
    expect([1, 2, 2.5, 5, 10].some((m) => Math.abs(step / 10 ** Math.floor(Math.log10(step)) - m) < 1e-9)).toBe(true);
  });

  it("NEGATİF DEĞER EKSENE SIĞAR", () => {
    // Zarar eden bir ay grafiğin dışında kalmamalı.
    const s = scaleFor([-400, 900]);
    expect(s.min).toBeLessThanOrEqual(-400);
    expect(s.max).toBeGreaterThanOrEqual(900);
  });

  it("TÜM DEĞERLER EŞİTSE ÖLÇEK ÇÖKMEZ", () => {
    // Sıfıra bölme; grafik komple kaybolurdu.
    const s = scaleFor([500, 500, 500], { includeZero: false });
    expect(s.max).toBeGreaterThan(s.min);
  });

  it("hiç bilinen değer yoksa da geçerli ölçek döner", () => {
    const s = scaleFor([null, null]);
    expect(s.max).toBeGreaterThan(s.min);
  });

  it("bilinmeyenler ölçeği bozmaz", () => {
    expect(scaleFor([100, null, 200])).toEqual(scaleFor([100, 200]));
  });
});

describe("çubuk yerleşimi", () => {
  const scale = scaleFor([0, 100]);

  it("çubuklar örtüşmez ve taşmaz", () => {
    const bars = barLayout([p("a", 50), p("b", 80), p("c", 20)], scale);
    expect(bars).toHaveLength(3);
    for (let i = 1; i < bars.length; i += 1) {
      expect(bars[i]!.x).toBeGreaterThanOrEqual(bars[i - 1]!.x + bars[i - 1]!.width);
    }
    const last = bars[bars.length - 1]!;
    expect(last.x + last.width).toBeLessThanOrEqual(100.001);
  });

  it("BİLİNMEYEN ÇUBUK ÇİZİLMEZ", () => {
    // Sıfır yükseklikte bir çubuk "değer sıfır" der; oysa değer yok.
    const bars = barLayout([p("a", 50), p("b", null), p("c", 20)], scale);
    expect(bars.map((b) => b.label)).toEqual(["a", "c"]);
  });

  it("bilinmeyen çubuğun YERİ korunur", () => {
    // Yer kaymasaydı "c" ikinci sıraya kayar, etiketle hizası bozulurdu.
    const bars = barLayout([p("a", 50), p("b", null), p("c", 20)], scale);
    expect(bars[1]!.x).toBeGreaterThan(66);
  });

  it("NEGATİF ÇUBUK SIFIR ÇİZGİSİNİN ALTINA İNER", () => {
    const s = scaleFor([-100, 100]);
    const bars = barLayout([p("kâr", 100), p("zarar", -100)], s);
    expect(bars[0]!.negative).toBe(false);
    expect(bars[1]!.negative).toBe(true);
    // Zarar çubuğu, kâr çubuğunun bittiği yerden başlar (sıfır çizgisi).
    expect(bars[1]!.y).toBeCloseTo(bars[0]!.y + bars[0]!.height, 5);
  });

  it("boş veri boş yerleşim", () => {
    expect(barLayout([], scale)).toEqual([]);
  });
});

describe("çizgi parçaları", () => {
  const scale = scaleFor([0, 100]);

  it("kesintisiz veri tek parça", () => {
    const seg = lineSegments([p("1", 10), p("2", 20), p("3", 30)], scale);
    expect(seg).toHaveLength(1);
    expect(seg[0]!.points).toHaveLength(3);
  });

  it("BİLİNMEYENDE ÇİZGİ KOPAR", () => {
    // Kopmasaydı, veri olmayan ay komşularının ortalamasıymış gibi
    // görünür ve orada bir ölçüm olduğu sanılırdı.
    const seg = lineSegments([p("1", 10), p("2", null), p("3", 30)], scale);
    expect(seg).toHaveLength(2);
    expect(seg[0]!.points).toHaveLength(1);
    expect(seg[1]!.points).toHaveLength(1);
  });

  it("uçlar 0 ve 100'e oturur", () => {
    const seg = lineSegments([p("1", 10), p("2", 20)], scale);
    expect(seg[0]!.points[0]!.x).toBe(0);
    expect(seg[0]!.points[1]!.x).toBe(100);
  });

  it("tek nokta ortaya konur", () => {
    const seg = lineSegments([p("1", 10)], scale);
    expect(seg[0]!.points[0]!.x).toBe(50);
  });
});

describe("halka dilimleri", () => {
  it("paylar toplamı bire eşittir", () => {
    const s = donutSlices([p("a", 30), p("b", 70)]);
    expect(s.reduce((t, x) => t + x.share, 0)).toBeCloseTo(1, 9);
  });

  it("NEGATİF DEĞERLİ VERİ HİÇ ÇİZİLMEZ", () => {
    // Bütünün parçası olmayan bir şey pay grafiğine giremez; girseydi
    // yüzdeler toplamı 100'ü aşardı.
    expect(donutSlices([p("a", 30), p("b", -10)])).toEqual([]);
  });

  it("toplam sıfırsa çizilmez", () => {
    expect(donutSlices([p("a", 0), p("b", 0)])).toEqual([]);
  });

  it("tek dilim tam daire olur ve yol üretir", () => {
    const s = donutSlices([p("hepsi", 100)]);
    expect(s).toHaveLength(1);
    expect(s[0]!.share).toBe(1);
    expect(s[0]!.path).toContain("A");
  });

  it("bilinmeyen dilim atlanır, kalan paylar yine bire tamamlanır", () => {
    const s = donutSlices([p("a", 30), p("b", null), p("c", 70)]);
    expect(s).toHaveLength(2);
    expect(s.reduce((t, x) => t + x.share, 0)).toBeCloseTo(1, 9);
  });
});

describe("birim kontrolü", () => {
  it("AYNI EKSENDE İKİ PARA BİRİMİ OLMAZ", () => {
    expect(sameUnit(["TRY", "EUR"])).toBe(false);
    expect(sameUnit(["TRY", "TRY"])).toBe(true);
  });

  it("bilinmeyen birim engel değildir", () => {
    expect(sameUnit(["TRY", null, "try"])).toBe(true);
  });
});

describe("oran", () => {
  it("ölçek çökmüşse sıfır döner — NaN üretmez", () => {
    expect(ratio(5, { min: 3, max: 3, ticks: [3] })).toBe(0);
  });
});
