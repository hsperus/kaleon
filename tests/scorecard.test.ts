/**
 * Tedarikçi karnesi ve sözleşme tavanı.
 *
 * EN ÖNEMLİ TEST "YETERSİZ VERİ" TESTİ. İki teslimatı olan bir
 * tedarikçiye "%100 termin" demek matematiksel olarak doğru ama
 * pratikte yanıltıcıdır — ve o yanıltıcı puan, satın alma kararını
 * belirler.
 */

import { describe, expect, it } from "vitest";
import {
  buildScorecard,
  assertWithinCeiling,
  ContractError,
  ASGARI_TESLIMAT,
  type DeliveryRecord,
} from "../src/modules/procurement/scorecard.js";

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

function teslimat(o: Partial<DeliveryRecord> = {}): DeliveryRecord {
  return {
    poId: "PO-1",
    itemId: "FR-22",
    promisedDate: d("2026-08-10"),
    receivedAt: d("2026-08-10"),
    orderedQuantity: 100,
    receivedQuantity: 100,
    ...o,
  };
}

const uc = (o: Partial<DeliveryRecord> = {}) => [
  teslimat({ poId: "PO-1", ...o }),
  teslimat({ poId: "PO-2", ...o }),
  teslimat({ poId: "PO-3", ...o }),
];

describe("tedarikçi karnesi", () => {
  it("AZ VERİYLE PUAN VERİLMEZ", () => {
    const k = buildScorecard("t1", "Petrol Ofisi", [teslimat(), teslimat()], []);
    expect(k.score).toBeNull();
    expect(k.onTimePercent).toBeNull();
    expect(k.verdict).toContain("Yetersiz veri");
    expect(k.verdict).toContain(String(ASGARI_TESLIMAT));
  });

  it("hepsi zamanında ve tam gelirse yüksek puan", () => {
    const k = buildScorecard("t1", "Petrol Ofisi", uc(), []);
    expect(k.onTimePercent).toBe(100);
    expect(k.inFullPercent).toBe(100);
    expect(k.score).toBe(100);
    expect(k.verdict).toContain("sözünü tutuyor");
  });

  it("iki gün gecikme TOLERANS içinde sayılır", () => {
    const k = buildScorecard("t1", "X", uc({ receivedAt: d("2026-08-12") }), []);
    expect(k.onTimePercent).toBe(100);
    expect(k.averageDelayDays).toBeNull();
  });

  it("üç gün gecikme ZAMANINDA sayılmaz", () => {
    const k = buildScorecard("t1", "X", uc({ receivedAt: d("2026-08-13") }), []);
    expect(k.onTimePercent).toBe(0);
    expect(k.averageDelayDays).toBe(3);
  });

  it("TERMİNİ OLMAYAN TESLİMAT PAYDADAN ÇIKARILIR", () => {
    /*
     * Zamanında saymak termin vermeyen tedarikçiyi ödüllendirir, geç
     * saymak cezalandırır. İkisi de olmayan bir veri hakkında
     * konuşmak olurdu.
     */
    const k = buildScorecard("t1", "X", [
      teslimat({ poId: "A" }),
      teslimat({ poId: "B" }),
      teslimat({ poId: "C", promisedDate: null }),
      teslimat({ poId: "D", promisedDate: null }),
    ], []);
    expect(k.onTimePercent).toBe(100); // yalnızca A ve B sayıldı
    expect(k.withoutPromise).toBe(2);
    expect(k.verdict).toContain("termin alınmamış");
  });

  it("eksik sevkiyat miktar puanını düşürür", () => {
    const k = buildScorecard("t1", "X", [
      teslimat({ poId: "A" }),
      teslimat({ poId: "B" }),
      teslimat({ poId: "C", receivedQuantity: 60 }),
    ], []);
    expect(k.inFullPercent).toBe(66.7);
  });

  it("fazla sevkiyat 'tam' sayılır — eksik değil", () => {
    const k = buildScorecard("t1", "X", uc({ receivedQuantity: 120 }), []);
    expect(k.inFullPercent).toBe(100);
  });

  it("fiyat artışı puanı düşürür ama AĞIRLIĞI DÜŞÜKTÜR", () => {
    // Fiyat teklif aşamasında zaten karşılaştırılıyor; karne
    // teklifin göremediğini ölçer: sözünü tutuyor mu.
    const temiz = buildScorecard("t1", "X", uc(), []);
    const zamli = buildScorecard("t1", "X", uc(), [
      { itemId: "FR-22", previousPrice: 100, currentPrice: 120 },
    ]);
    expect(zamli.priceChangePercent).toBe(20);
    expect(zamli.score).toBeLessThan(temiz.score!);
    // 20% zam yalnızca 4 puan götürüyor: termin ve miktar baskın.
    expect(temiz.score! - zamli.score!).toBe(4);
  });

  it("fiyat düşüşü ceza üretmez", () => {
    const k = buildScorecard("t1", "X", uc(), [
      { itemId: "FR-22", previousPrice: 100, currentPrice: 80 },
    ]);
    expect(k.priceChangePercent).toBe(-20);
    expect(k.score).toBe(100);
  });

  it("kötü performans ZAYIF hükmü alır", () => {
    const k = buildScorecard("t1", "X", [
      teslimat({ poId: "A", receivedAt: d("2026-08-25"), receivedQuantity: 50 }),
      teslimat({ poId: "B", receivedAt: d("2026-08-30"), receivedQuantity: 40 }),
      teslimat({ poId: "C", receivedAt: d("2026-09-05"), receivedQuantity: 30 }),
    ], []);
    expect(k.score).toBeLessThan(65);
    expect(k.verdict).toContain("Zayıf");
  });
});

const kullanim = (o: Partial<Parameters<typeof assertWithinCeiling>[0]> = {}) => ({
  usedAmount: 400_000,
  usedQuantity: 4_000,
  ceilingAmount: 1_000_000,
  ceilingQuantity: 10_000,
  remainingAmount: 600_000,
  remainingQuantity: 6_000,
  ...o,
});

describe("sözleşme tavanı", () => {
  it("tavan içinde kalan çekiliş geçer", () => {
    expect(() => assertWithinCeiling(kullanim(), 500_000, 5_000, "SOZ-1")).not.toThrow();
  });

  it("TUTAR TAVANI AŞILAMAZ", () => {
    expect(() => assertWithinCeiling(kullanim(), 700_000, 1_000, "SOZ-1")).toThrow(ContractError);
    expect(() => assertWithinCeiling(kullanim(), 700_000, 1_000, "SOZ-1")).toThrow(
      /yeni bir anlaşma gerektirir/,
    );
  });

  it("MİKTAR TAVANI DA AŞILAMAZ", () => {
    expect(() => assertWithinCeiling(kullanim(), 100, 7_000, "SOZ-1")).toThrow(/miktar tavanı/);
  });

  it("tavansız sözleşmede çekiliş sınırsızdır — fiyatı sabitler yalnızca", () => {
    const acik = kullanim({ ceilingAmount: null, ceilingQuantity: null });
    expect(() => assertWithinCeiling(acik, 99_000_000, 999_999, "SOZ-2")).not.toThrow();
  });

  it("tam tavanda kalan çekiliş geçer, bir kuruş fazlası geçmez", () => {
    expect(() => assertWithinCeiling(kullanim(), 600_000, 6_000, "SOZ-1")).not.toThrow();
    expect(() => assertWithinCeiling(kullanim(), 600_001, 6_000, "SOZ-1")).toThrow(ContractError);
  });
});
