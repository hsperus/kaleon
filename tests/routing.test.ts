/**
 * Rota yükü ve maliyet sapması.
 *
 * EN ÖNEMLİ TEST HAZIRLIK/İŞLEME AYRIMI. Tek bir "süre" alanıyla 10
 * adetlik parti ile 1000 adetlik parti aynı birim süreyle
 * hesaplanırdı — ve o hesap, küçük siparişe verilen fiyatı doğrudan
 * yanlış yapardı.
 */

import { describe, expect, it } from "vitest";
import {
  computeLoad,
  analyzeVariance,
  RoutingError,
  type Operation,
} from "../src/modules/operations/routing.js";

const ROTA: Operation[] = [
  { seq: 10, workCenterId: "TESTERE", description: "Kesme", setupMinutes: 15, runMinutesPerUnit: 0.5 },
  { seq: 20, workCenterId: "CNC", description: "Talaşlı imalat", setupMinutes: 45, runMinutesPerUnit: 4 },
  { seq: 30, workCenterId: "MONTAJ", description: "Montaj", setupMinutes: 5, runMinutesPerUnit: 2 },
];

describe("rota yükü", () => {
  it("HAZIRLIK PARTİ BAŞINA, İŞLEME ADET BAŞINA", () => {
    const l = computeLoad(ROTA, 100);
    // Hazırlık: 15+45+5 = 65 · İşleme: (0.5+4+2)*100 = 650
    expect(l.setupTotal).toBe(65);
    expect(l.runTotal).toBe(650);
    expect(l.totalMinutes).toBe(715);
  });

  it("BİRİM SÜRE PARTİ BÜYÜKLÜĞÜNE GÖRE DEĞİŞİR", () => {
    /*
     * "Neden küçük siparişe daha pahalı fiyat veriyoruz" sorusunun
     * cevabı bu farkta.
     */
    const kucuk = computeLoad(ROTA, 10);
    const buyuk = computeLoad(ROTA, 1000);
    expect(kucuk.minutesPerUnit).toBe(13);      // 65/10 + 6.5
    expect(buyuk.minutesPerUnit).toBe(6.565);   // 65/1000 + 6.5
    expect(kucuk.minutesPerUnit).toBeGreaterThan(buyuk.minutesPerUnit * 1.9);
  });

  it("darboğaz operasyonu bildirilir", () => {
    const l = computeLoad(ROTA, 100);
    expect(l.bottleneck).toBe("CNC");
  });

  it("operasyon payları toplamı yüzde yüze yakındır", () => {
    const l = computeLoad(ROTA, 100);
    const toplam = l.operations.reduce((s, o) => s + o.sharePercent, 0);
    expect(toplam).toBeGreaterThan(99.5);
    expect(toplam).toBeLessThan(100.5);
  });

  it("operasyonlar sıra numarasına göre döner", () => {
    const karisik = [ROTA[2]!, ROTA[0]!, ROTA[1]!];
    expect(computeLoad(karisik, 10).operations.map((o) => o.seq)).toEqual([10, 20, 30]);
  });

  it("BOŞ ROTA REDDEDİLİR", () => {
    expect(() => computeLoad([], 10)).toThrow(RoutingError);
  });

  it("sıfır miktar reddedilir", () => {
    expect(() => computeLoad(ROTA, 0)).toThrow(/sıfırdan büyük/);
  });
});

const STD = { material: 120, labor: 45, overhead: 18 };

describe("maliyet sapması", () => {
  it("standartla birebir aynıysa sapma sıfırdır", () => {
    const r = analyzeVariance("FR-22", 100, STD, { material: 12_000, labor: 4_500, overhead: 1_800 });
    expect(r.totalVariance).toBe(0);
    expect(r.worstComponent).toBeNull();
    expect(r.summary).toContain("birebir aynı");
  });

  it("ÜÇ BİLEŞEN AYRI RAPORLANIR", () => {
    /*
     * Toplam sapmayı bilmek "bir sorun var" demek; hangi bileşende
     * sapıldığını bilmek "nereye bakılacağını" söyler. Malzeme
     * sapması satın almanın işi, işçilik sapması üretimin.
     */
    const r = analyzeVariance("FR-22", 100, STD, { material: 13_500, labor: 4_200, overhead: 1_800 });
    const malzeme = r.components.find((c) => c.component === "material")!;
    const iscilik = r.components.find((c) => c.component === "labor")!;
    expect(malzeme.variance).toBe(1_500);
    expect(malzeme.variancePercent).toBe(12.5);
    expect(iscilik.variance).toBe(-300);
    expect(r.totalVariance).toBe(1_200);
  });

  it("EN KÖTÜ BİLEŞEN MUTLAK SAPMAYA GÖRE SEÇİLİR, YÜZDEYE GÖRE DEĞİL", () => {
    /*
     * Yüzdeye göre seçmek, küçük bir kalemdeki %300'ü büyük bir
     * kalemdeki %5'in önüne koyar — oysa paraya dönüşen ikincisidir.
     */
    const r = analyzeVariance("FR-22", 100, STD, {
      material: 12_600,  // +600, %5
      labor: 4_500,
      overhead: 3_600,   // +1800 ama küçük kalem... aslında büyük
    });
    expect(r.worstComponent).toBe("Genel üretim gideri");

    const r2 = analyzeVariance("FR-22", 100, { material: 1000, labor: 10, overhead: 5 }, {
      material: 105_000,  // +5000, %5
      labor: 1_030,       // +30, %300
      overhead: 500,
    });
    expect(r2.worstComponent).toBe("Malzeme");
  });

  it("tasarruf da raporlanır", () => {
    const r = analyzeVariance("FR-22", 100, STD, { material: 11_000, labor: 4_500, overhead: 1_800 });
    expect(r.totalVariance).toBe(-1_000);
    expect(r.summary).toContain("TASARRUF");
  });

  it("standardı sıfır olan bileşende oran TANIMSIZ, sıfır değil", () => {
    const r = analyzeVariance("FR-22", 10, { material: 100, labor: 0, overhead: 0 }, {
      material: 1_000,
      labor: 500,
      overhead: 0,
    });
    const iscilik = r.components.find((c) => c.component === "labor")!;
    expect(iscilik.variancePercent).toBeNull();
    expect(iscilik.variance).toBe(500);
  });

  it("sıfır miktarda sapma tanımsızdır", () => {
    expect(() => analyzeVariance("FR-22", 0, STD, { material: 0, labor: 0, overhead: 0 })).toThrow(
      RoutingError,
    );
  });
});
