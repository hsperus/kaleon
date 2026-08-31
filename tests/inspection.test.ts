/**
 * Muayene değerlendirmesi.
 *
 * TEST EDİLEN ŞEY ÖLÇÜMÜ TOLERANSLA KARŞILAŞTIRMAK DEĞİL — o aritmetik.
 * Test edilen şey, muayenenin EKSİK YAPILAMAMASI ve kritik bir
 * sapmanın "şartlı kabul" kapısından geçememesi.
 */

import { describe, expect, it } from "vitest";
import {
  evaluateLot,
  InspectionError,
  type Characteristic,
  type Measurement,
} from "../src/modules/quality/inspection.js";

const c = (o: Partial<Characteristic> = {}): Characteristic => ({
  id: "k1",
  seq: 1,
  name: "Sertlik",
  kind: "numeric",
  uom: "HRC",
  lowerLimit: 45,
  upperLimit: 55,
  isCritical: false,
  ...o,
});

const m = (o: Partial<Measurement> = {}): Measurement => ({
  characteristicId: "k1",
  measured: 50,
  conforms: null,
  note: null,
  ...o,
});

describe("muayene değerlendirmesi", () => {
  it("tolerans içindeki ölçüm geçer", () => {
    const e = evaluateLot([c()], [m()]);
    expect(e.result).toBe("passed");
    expect(e.results[0]!.conforms).toBe(true);
  });

  it("alt sınırın altındaki ölçüm SAPMAYI RAKAMLA söyler", () => {
    const e = evaluateLot([c()], [m({ measured: 41 })]);
    expect(e.result).toBe("conditional");
    expect(e.results[0]!.deviation).toBe("Sertlik: ölçülen 41 HRC, alt sınır 45 HRC (4 HRC altında)");
  });

  it("üst sınırın üstündeki ölçüm de aynı biçimde", () => {
    const e = evaluateLot([c()], [m({ measured: 58.5 })]);
    expect(e.results[0]!.deviation).toContain("3.5 HRC üstünde");
  });

  it("TEK YÖNLÜ TOLERANS: yalnızca alt sınır", () => {
    // "En az 45 HRC" — üst sınırı yoktur.
    const e = evaluateLot([c({ upperLimit: null })], [m({ measured: 200 })]);
    expect(e.result).toBe("passed");
  });

  it("tek yönlü tolerans: yalnızca üst sınır", () => {
    // "En fazla 3,2 µm yüzey pürüzlülüğü".
    const e = evaluateLot(
      [c({ name: "Pürüzlülük", uom: "µm", lowerLimit: null, upperLimit: 3.2 })],
      [m({ measured: 0.4 })],
    );
    expect(e.result).toBe("passed");
  });

  it("KRİTİK SAPMADA ŞARTLI KABUL YOKTUR", () => {
    /*
     * Normal sapma "şartlı kabul" olabilir; kritik sapma olamaz.
     * Olsaydı en tehlikeli sapma en kolay aşılan olurdu.
     */
    const e = evaluateLot([c({ isCritical: true })], [m({ measured: 20 })]);
    expect(e.result).toBe("failed");
    expect(e.criticalFailedCount).toBe(1);
    expect(e.summary).toContain("kritik özellikte şartlı kabul yoktur");
  });

  it("kritik olmayan sapma ŞARTLI KABUL üretir ve bildirim gerektirdiğini söyler", () => {
    const e = evaluateLot([c()], [m({ measured: 44 })]);
    expect(e.result).toBe("conditional");
    expect(e.summary).toContain("müşteriye bildirilmeyi gerektirir");
  });

  it("EKSİK ÖLÇÜM MUAYENEYİ TAMAMLAMAZ", () => {
    // Dördünü ölçüp "geçti" demek, ölçülmeyenin sapmadığını varsaymaktır.
    const plan = [c({ id: "k1" }), c({ id: "k2", seq: 2, name: "Çap" })];
    expect(() => evaluateLot(plan, [m({ characteristicId: "k1" })])).toThrow(InspectionError);
    expect(() => evaluateLot(plan, [m({ characteristicId: "k1" })])).toThrow(/Çap/);
  });

  it("SAYISAL ÖZELLİKTE DEĞER ZORUNLU", () => {
    expect(() => evaluateLot([c()], [m({ measured: null })])).toThrow(/ölçülen değer yazılmalıdır/);
  });

  it("NİTELİK ÖZELLİĞİNDE UYGUNLUK ZORUNLU", () => {
    const nitelik = c({ kind: "attribute", uom: null, lowerLimit: null, upperLimit: null });
    expect(() => evaluateLot([nitelik], [m({ measured: null, conforms: null })])).toThrow(
      /uygun olup olmadığı yazılmalıdır/,
    );
  });

  it("nitelik özelliği notuyla birlikte raporlanır", () => {
    const nitelik = c({ kind: "attribute", name: "Yüzey", uom: null, lowerLimit: null, upperLimit: null });
    const e = evaluateLot([nitelik], [m({ measured: null, conforms: false, note: "çizik var" })]);
    expect(e.results[0]!.deviation).toBe("Yüzey: uygun değil — çizik var");
  });

  it("BOŞ PLAN REDDEDİLİR", () => {
    expect(() => evaluateLot([], [])).toThrow(/hiçbir şey denetlemez/);
  });

  it("sonuçlar plandaki sıraya göre döner", () => {
    const plan = [
      c({ id: "k2", seq: 2, name: "İkinci" }),
      c({ id: "k1", seq: 1, name: "Birinci" }),
    ];
    const e = evaluateLot(plan, [
      m({ characteristicId: "k1" }),
      m({ characteristicId: "k2" }),
    ]);
    expect(e.results.map((r) => r.name)).toEqual(["Birinci", "İkinci"]);
  });

  it("birden fazla sapmada hepsi listelenir", () => {
    const plan = [
      c({ id: "k1", seq: 1, name: "Sertlik" }),
      c({ id: "k2", seq: 2, name: "Çap", uom: "mm", lowerLimit: 10, upperLimit: 12 }),
    ];
    const e = evaluateLot(plan, [
      m({ characteristicId: "k1", measured: 30 }),
      m({ characteristicId: "k2", measured: 15 }),
    ]);
    expect(e.failedCount).toBe(2);
    expect(e.summary).toContain("Sertlik, Çap");
  });
});
