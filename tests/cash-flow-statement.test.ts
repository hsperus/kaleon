/**
 * Nakit akış tablosu — dolaylı yöntem.
 *
 * BU TABLONUN EN SIK KUSURU İŞARET HATASIDIR ve fark ettirmez: tablo
 * yine "denk" görünür, yalnızca kalemi yanlış tarafa yazar. Testlerin
 * çoğu tek bir şeyi kontrol ediyor — varlık artışı nakdi AZALTIYOR mu.
 */

import { describe, expect, it } from "vitest";
import { buildCashFlowStatement } from "../src/modules/accounting/cash-flow-statement.js";

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const OCAK = d("2026-01-01");
const ARALIK = d("2026-12-31");

/** Borç bakiyesi pozitif, alacak bakiyesi negatif. */
const bak = (o: Record<string, number>) => new Map(Object.entries(o));

describe("nakit akış tablosu", () => {
  it("VARLIK ARTIŞI NAKDİ AZALTIR", () => {
    // Alacak 100.000 arttı: mal gitti, para gelmedi.
    const r = buildCashFlowStatement(
      OCAK,
      ARALIK,
      0,
      bak({ "100": 500_000, "120": 0 }),
      bak({ "100": 400_000, "120": 100_000 }),
    );
    const satir = r.operating.find((l) => l.label.includes("alacak"))!;
    expect(satir.amount).toBe(-100_000);
    expect(r.balanced).toBe(true);
  });

  it("BORÇ ARTIŞI NAKDİ ARTIRIR", () => {
    // Satıcı borcu 80.000 arttı (alacak bakiyeli → negatif).
    const r = buildCashFlowStatement(
      OCAK,
      ARALIK,
      0,
      bak({ "102": 200_000, "320": 0 }),
      bak({ "102": 280_000, "320": -80_000 }),
    );
    const satir = r.operating.find((l) => l.label.includes("borç"))!;
    expect(satir.amount).toBe(80_000);
    expect(r.balanced).toBe(true);
  });

  it("amortisman kâra GERİ EKLENİR — nakit çıkışı değildir", () => {
    // 981.500 amortisman: kâr o kadar düşük ama nakit çıkmadı.
    const r = buildCashFlowStatement(
      OCAK,
      ARALIK,
      -601_890,
      bak({ "102": 1_000_000, "253": 5_000_000, "257": 0 }),
      bak({ "102": 1_379_610, "253": 5_000_000, "257": -981_500 }),
    );
    const satir = r.operating.find((l) => l.label.includes("Amortisman"))!;
    expect(satir.amount).toBe(981_500);
    expect(r.operatingTotal).toBe(379_610);
    expect(r.balanced).toBe(true);
  });

  it("duran varlık alımı YATIRIM bölümünde ve negatif", () => {
    const r = buildCashFlowStatement(
      OCAK,
      ARALIK,
      0,
      bak({ "102": 3_000_000, "253": 0 }),
      bak({ "102": 1_000_000, "253": 2_000_000 }),
    );
    expect(r.investingTotal).toBe(-2_000_000);
    expect(r.balanced).toBe(true);
  });

  it("kredi kullanımı FİNANSMAN bölümünde ve pozitif", () => {
    const r = buildCashFlowStatement(
      OCAK,
      ARALIK,
      0,
      bak({ "102": 0, "300": 0 }),
      bak({ "102": 1_500_000, "300": -1_500_000 }),
    );
    expect(r.financingTotal).toBe(1_500_000);
    expect(r.balanced).toBe(true);
  });

  it("KONTROL SATIRI: kaçırılan hesap grubu tabloyu DENGESİZ yapar", () => {
    // 999 hiçbir gruba girmiyor: nakit değişti ama sebebi yazılamadı.
    const r = buildCashFlowStatement(
      OCAK,
      ARALIK,
      0,
      bak({ "102": 0, "999": 0 }),
      bak({ "102": 250_000, "999": -250_000 }),
    );
    expect(r.balanced).toBe(false);
    expect(r.checkDifference).toBe(-250_000);
  });

  it("açılış ve kapanış nakdi 100 ile 102'yi birlikte sayar", () => {
    const r = buildCashFlowStatement(
      OCAK,
      ARALIK,
      0,
      bak({ "100": 50_000, "102": 150_000 }),
      bak({ "100": 60_000, "102": 140_000 }),
    );
    expect(r.openingCash).toBe(200_000);
    expect(r.closingCash).toBe(200_000);
    expect(r.netChange).toBe(0);
  });

  it("hiç hareket yoksa tablo sıfırlarla ve DENK döner", () => {
    const r = buildCashFlowStatement(OCAK, ARALIK, 0, bak({ "102": 100 }), bak({ "102": 100 }));
    expect(r.netChange).toBe(0);
    expect(r.balanced).toBe(true);
  });

  /*
   * TABLONUN VAR OLMA SEBEBİ BU SENARYO.
   *
   * Şirket 400.000 ₺ kâr etti ve nakdi 1,1 milyon azaldı. Gelir
   * tablosu bunu açıklayamaz, bilanço da açıklayamaz — yalnızca bu
   * tablo söyler: alacaklar 1,5 milyon büyüdü ve 600.000 ₺ makineye
   * gitti.
   *
   * MİZAN GERÇEKTEN DENKTİR: 6xx/7xx net bakiyesi (−400.000) dahil
   * bütün hesaplar sıfıra toplanıyor. Denk olmayan bir mizanla
   * kurulan test, kontrol satırını da test etmiş olmaz.
   */
  it("gerçekçi bir dönem: kâr var, nakit azalmış", () => {
    const r = buildCashFlowStatement(
      OCAK,
      ARALIK,
      400_000,
      bak({
        "102": 2_000_000, "120": 1_000_000, "253": 3_000_000,
        "257": -500_000, "320": -800_000, "500": -4_700_000,
      }),
      bak({
        "102": 900_000, "120": 2_500_000, "253": 3_600_000,
        "257": -900_000, "320": -1_000_000, "500": -4_700_000,
        // Dönem sonucu gelir/gider hesaplarında duruyor; tablo onu
        // `netProfit` üzerinden alır, grup olarak saymaz.
        "690": -400_000,
      }),
    );
    expect(r.operatingTotal).toBe(-500_000);  // 400k kâr + 400k amort − 1,5M alacak + 200k borç
    expect(r.investingTotal).toBe(-600_000);
    expect(r.financingTotal).toBe(0);
    expect(r.netChange).toBe(-1_100_000);
    expect(r.closingCash - r.openingCash).toBe(-1_100_000);
    expect(r.balanced).toBe(true);
  });
});
