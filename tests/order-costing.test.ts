/**
 * İş emri maliyeti ve sapma analizi.
 *
 * Bu modülün tek işi "bu ürün bize kaça mal oluyor" sorusuna DÜRÜST cevap
 * vermektir. Dürüstlüğün ölçüsü şudur: bilinmeyen bir maliyet unsuru,
 * sıfır olarak toplanmaz. Toplansaydı ürün olduğundan ucuz görünür ve
 * fiyat listesi buna göre çıkardı.
 */

import { describe, expect, it } from "vitest";
import {
  accumulate,
  variance,
  varianceByElement,
  VARIANCE_ATTENTION,
  VARIANCE_CRITICAL,
} from "../src/modules/operations/order-costing.js";

const materials = [
  { itemCode: "HM-100", quantity: 200, value: 10_000 },
  { itemCode: "SF-001", quantity: 420, value: 840 },
];
const labor = [
  { workCenter: "KESIM", hours: 8, hourlyRate: 150 },
  { workCenter: "KAYNAK", hours: 12, hourlyRate: 200 },
];

describe("maliyet toplama", () => {
  it("üç unsur ayrı ayrı toplanır", () => {
    const c = accumulate({
      materials,
      labor,
      overhead: { rateOnLaborPercent: 40 },
    });
    expect(c.material).toBe(10_840);
    expect(c.labor).toBe(3_600); // 8×150 + 12×200
    expect(c.overhead).toBe(1_440); // %40
    expect(c.total).toBe(15_880);
    expect(c.unknowns).toEqual([]);
  });

  it("MALİYETİ BİLİNMEYEN MALZEME SIFIR SAYILMAZ", () => {
    // Sayılsaydı ürün olduğundan ucuz görünür ve fiyat listesi bozulurdu.
    const c = accumulate({
      materials: [...materials, { itemCode: "HM-900", quantity: 5, value: null }],
      labor,
      overhead: { rateOnLaborPercent: 40 },
    });
    expect(c.material).toBe(10_840);
    expect(c.unknowns[0]).toContain("HM-900");
    expect(c.unknowns[0]).toContain("maliyeti bilinmiyor");
  });

  it("İŞÇİLİK ÜCRETİ TANIMSIZSA SIFIR YAZILMAZ", () => {
    const c = accumulate({
      materials,
      labor: [{ workCenter: "BOYA", hours: 10, hourlyRate: null }],
      overhead: { rateOnLaborPercent: 40 },
    });
    expect(c.labor).toBe(0);
    expect(c.unknowns.some((u) => u.includes("BOYA"))).toBe(true);
    expect(c.unknowns.some((u) => u.includes("genel üretim gideri de eksik"))).toBe(true);
  });

  it("GÜG ORANI YOKSA UYDURULMAZ", () => {
    const c = accumulate({ materials, labor, overhead: { rateOnLaborPercent: null } });
    expect(c.overhead).toBe(0);
    expect(c.unknowns.some((u) => u.includes("yükleme oranı"))).toBe(true);
  });

  it("işçilik yoksa GÜG uyarısı da çıkmaz", () => {
    const c = accumulate({ materials, labor: [], overhead: { rateOnLaborPercent: null } });
    expect(c.unknowns).toEqual([]);
    expect(c.total).toBe(10_840);
  });
});

describe("sapma", () => {
  const actual = accumulate({ materials, labor, overhead: { rateOnLaborPercent: 40 } });

  it("fiili birim maliyet hesaplanır", () => {
    const v = variance({ quantityProduced: 100, actual, standardUnitCost: 150 });
    expect(v.actualUnitCost).toBe(158.8);
    expect(v.unitVariance).toBe(8.8);
    expect(v.totalVariance).toBe(880);
    expect(v.variancePercent).toBe(5.87);
  });

  it("SAPMA EŞİĞE GÖRE SINIFLANIR", () => {
    expect(variance({ quantityProduced: 100, actual, standardUnitCost: 158 }).severity).toBe(
      "kabul",
    );
    expect(variance({ quantityProduced: 100, actual, standardUnitCost: 150 }).severity).toBe(
      "dikkat",
    );
    expect(variance({ quantityProduced: 100, actual, standardUnitCost: 130 }).severity).toBe(
      "kritik",
    );
  });

  it("eşikler makul aralıkta", () => {
    expect(VARIANCE_ATTENTION).toBeLessThan(VARIANCE_CRITICAL);
  });

  it("STANDART YOKSA SAPMA 'SIFIR' DEĞİL 'BİLİNMİYOR'", () => {
    const v = variance({ quantityProduced: 100, actual, standardUnitCost: null });
    expect(v.actualUnitCost).toBe(158.8);
    expect(v.unitVariance).toBe(null);
    expect(v.explanation).toContain("BİLİNMİYOR");
  });

  it("ÜRETİM YOKSA BİRİM MALİYET HESAPLANMAZ", () => {
    // Sıfıra bölmek yerine "hesaplanamaz" der.
    const v = variance({ quantityProduced: 0, actual, standardUnitCost: 150 });
    expect(v.actualUnitCost).toBe(null);
    expect(v.explanation).toContain("Henüz üretim yok");
  });

  it("ucuza mal olma da sapmadır", () => {
    const v = variance({ quantityProduced: 100, actual, standardUnitCost: 200 });
    expect(v.unitVariance).toBeLessThan(0);
    expect(v.explanation).toContain("ucuza");
    expect(v.severity).toBe("kritik");
  });

  it("açıklama rakam içerir", () => {
    const v = variance({ quantityProduced: 100, actual, standardUnitCost: 150 });
    expect(v.explanation).toContain("158.8");
    expect(v.explanation).toContain("150");
  });
});

describe("sapmanın kaynağı", () => {
  const actual = accumulate({ materials, labor, overhead: { rateOnLaborPercent: 40 } });

  it("HANGİ UNSURDAN GELDİĞİ AYRIŞIR", () => {
    // "Pahalıya mal oldu" tek başına karar verdirmez; malzeme mi fazla
    // harcandı, süre mi uzadı sorusunun cevabı eylemi belirler.
    const rows = varianceByElement(actual, { material: 10_000, labor: 3_000, overhead: 1_200 });
    expect(rows[0]).toMatchObject({ element: "Direkt malzeme (710)", variance: 840 });
    expect(rows[1]).toMatchObject({ element: "Direkt işçilik (720)", variance: 600 });
    expect(rows[2]).toMatchObject({ element: "Genel üretim gideri (730)", variance: 240 });
  });

  it("standart yoksa fark null kalır", () => {
    const rows = varianceByElement(actual, null);
    expect(rows.every((r) => r.variance === null)).toBe(true);
    expect(rows[0]!.actual).toBe(10_840);
  });
});
