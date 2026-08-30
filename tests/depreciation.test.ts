/**
 * Amortisman — VUK kuralları.
 *
 * AMORTİSMAN VERGİ MATRAHINI DOĞRUDAN DEĞİŞTİRİR. Fazla ayrılan
 * amortisman matrahı düşürür ve incelemede cezalı tarhiyata yol açar;
 * eksik ayrılan, işletmenin hakkı olan gideri yakar. Testler kanunun
 * üç kuralını (oran, tavan, kıst) ve amortismanın SIFIRLANMASINI
 * hedefliyor.
 */

import { describe, expect, it } from "vitest";
import {
  annualRate,
  disposalResult,
  forYear,
  schedule,
  DepreciationError,
} from "../src/modules/assets/depreciation.js";

const d = (iso: string): Date => new Date(iso);

describe("yıllık oran", () => {
  it("normal yöntemde ömre bölünür", () => {
    expect(annualRate(5, "normal")).toBeCloseTo(0.2, 10);
    expect(annualRate(10, "normal")).toBeCloseTo(0.1, 10);
  });

  it("azalan bakiyelerde İKİ KATIDIR", () => {
    expect(annualRate(10, "azalan")).toBeCloseTo(0.2, 10);
    expect(annualRate(5, "azalan")).toBeCloseTo(0.4, 10);
  });

  it("AZALAN BAKİYELERDE TAVAN %50", () => {
    // 3 yıllık kıymette iki kat oran %66,67 olurdu; kanun izin vermez.
    expect(annualRate(3, "azalan")).toBe(0.5);
    expect(annualRate(2, "azalan")).toBe(0.5);
  });

  it("geçersiz ömür reddedilir", () => {
    expect(() => annualRate(0, "normal")).toThrow(DepreciationError);
  });
});

describe("normal amortisman", () => {
  const asset = {
    cost: 100_000,
    usefulLifeYears: 5,
    method: "normal" as const,
    acquiredAt: d("2026-01-15"),
    prorated: false,
  };

  it("eşit tutarlarla beş yılda biter", () => {
    const s = schedule(asset);
    expect(s).toHaveLength(5);
    expect(s.every((r) => r.amount === 20_000)).toBe(true);
    expect(s[4]!.bookValue).toBe(0);
    expect(s[4]!.accumulated).toBe(100_000);
  });

  it("TOPLAM MALİYETİ AŞMAZ", () => {
    // Aşarsa vergi matrahı olduğundan düşük çıkar.
    const total = schedule(asset).reduce((t, r) => t + r.amount, 0);
    expect(total).toBe(100_000);
  });

  it("yıllar iktisap yılından başlar", () => {
    expect(schedule(asset)[0]!.year).toBe(2026);
    expect(schedule(asset)[4]!.year).toBe(2030);
  });
});

describe("azalan bakiyeler", () => {
  const asset = {
    cost: 100_000,
    usefulLifeYears: 5,
    method: "azalan" as const,
    acquiredAt: d("2026-01-01"),
    prorated: false,
  };

  it("ilk yıl en yüksek, sonra azalır", () => {
    const s = schedule(asset);
    expect(s[0]!.amount).toBe(40_000);
    expect(s[1]!.amount).toBe(24_000);
    expect(s[2]!.amount).toBe(14_400);
    expect(s[1]!.amount).toBeLessThan(s[0]!.amount);
  });

  it("SON YIL KALANIN TAMAMI YAZILIR — varlık sıfırlanır", () => {
    // Yazılmasaydı defterde sonsuza kadar küçülen bir bakiye kalırdı.
    const s = schedule(asset);
    expect(s[s.length - 1]!.bookValue).toBe(0);
    expect(s.reduce((t, r) => t + r.amount, 0)).toBe(100_000);
  });
});

describe("kıst amortisman (VUK 320)", () => {
  it("İKTİSAP AYINDAN İTİBAREN AY SAYILIR", () => {
    // 15 Mart'ta alınan binek otomobil: mart dahil 10 ay.
    const s = schedule({
      cost: 120_000,
      usefulLifeYears: 5,
      method: "normal",
      acquiredAt: d("2026-03-15"),
      prorated: true,
    });
    expect(s[0]!.months).toBe(10);
    // 120.000 × %20 × 10/12 = 20.000
    expect(s[0]!.amount).toBe(20_000);
    expect(s[1]!.amount).toBe(24_000);
  });

  it("ilk yıl yazılamayan kısım ÖMRÜN SONUNA EKLENİR", () => {
    // Kaybolsaydı işletme hakkı olan gideri yakardı.
    const s = schedule({
      cost: 120_000,
      usefulLifeYears: 5,
      method: "normal",
      acquiredAt: d("2026-03-15"),
      prorated: true,
    });
    expect(s).toHaveLength(6);
    expect(s.reduce((t, r) => t + r.amount, 0)).toBe(120_000);
    expect(s[5]!.bookValue).toBe(0);
  });

  it("ARALIKTA ALINAN KIYMETE 1 AY", () => {
    const s = schedule({
      cost: 120_000,
      usefulLifeYears: 5,
      method: "normal",
      acquiredAt: d("2026-12-20"),
      prorated: true,
    });
    expect(s[0]!.months).toBe(1);
    expect(s[0]!.amount).toBe(2_000);
  });

  it("KIST OLMAYAN KIYMETE TAM YIL — makineye kıst uygulanmaz", () => {
    // Uygulansaydı amortisman eksik ayrılırdı.
    const s = schedule({
      cost: 120_000,
      usefulLifeYears: 5,
      method: "normal",
      acquiredAt: d("2026-12-20"),
      prorated: false,
    });
    expect(s[0]!.months).toBe(12);
    expect(s[0]!.amount).toBe(24_000);
    expect(s).toHaveLength(5);
  });
});

describe("belirli yıl", () => {
  const asset = {
    cost: 50_000,
    usefulLifeYears: 5,
    method: "normal" as const,
    acquiredAt: d("2026-01-01"),
    prorated: false,
  };

  it("ömür içindeki yılı verir", () => {
    expect(forYear(asset, 2028)?.amount).toBe(10_000);
  });

  it("ÖMÜR DIŞINDA SIFIR DEĞİL NULL DÖNER", () => {
    // Sıfır yazılsaydı defterde tutarsız bir fiş oluşurdu.
    expect(forYear(asset, 2025)).toBeNull();
    expect(forYear(asset, 2032)).toBeNull();
  });
});

describe("elden çıkarma", () => {
  it("kâr NET DEFTER DEĞERİNE göre hesaplanır", () => {
    // Maliyete göre hesaplansaydı her satış zarar gösterirdi.
    const r = disposalResult(100_000, 80_000, 30_000);
    expect(r.bookValue).toBe(20_000);
    expect(r.gain).toBe(10_000);
  });

  it("zarar da doğru çıkar", () => {
    expect(disposalResult(100_000, 20_000, 50_000).gain).toBe(-30_000);
  });

  it("tam amorti kıymetin satışı tamamen kârdır", () => {
    const r = disposalResult(100_000, 100_000, 5_000);
    expect(r.bookValue).toBe(0);
    expect(r.gain).toBe(5_000);
  });
});

describe("geçersiz girdi", () => {
  const base = { usefulLifeYears: 5, method: "normal" as const, acquiredAt: d("2026-01-01"), prorated: false };
  it("bedel pozitif olmalı", () => {
    expect(() => schedule({ ...base, cost: 0 })).toThrow(DepreciationError);
  });
  it("ömür tam yıl olmalı", () => {
    expect(() => schedule({ ...base, cost: 1000, usefulLifeYears: 2.5 })).toThrow(DepreciationError);
  });
});
