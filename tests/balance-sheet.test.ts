/**
 * Bilanço.
 *
 * BİLANÇONUN TEK BİR DOĞRU CEVABI VARDIR: aktif = pasif. Denk gelmeyen
 * bir bilanço bankaya verilemez, mali müşavir kabul etmez ve sistemin
 * tüm mali çıktısına duyulan güveni bitirir. Testler denkliği ve onu
 * bozan üç durumu hedefliyor.
 */

import { describe, expect, it } from "vitest";
import { balanceSheet, type TrialBalanceRow } from "../src/modules/accounting/journal.js";

const row = (
  code: string,
  name: string,
  balance: number,
  statement: "bilanco" | "gelir" = "bilanco",
): TrialBalanceRow => ({
  accountCode: code,
  accountName: name,
  debit: balance > 0 ? balance : 0,
  credit: balance > 0 ? 0 : -balance,
  balance,
  statement,
});

describe("bilanço", () => {
  it("aktif ve pasif doğru gruplara düşer", () => {
    const b = balanceSheet(
      [
        row("102", "Bankalar", 250_000),
        row("120", "Alıcılar", 400_000),
        row("152", "Mamuller", 150_000),
        row("320", "Satıcılar", 300_000),
        row("500", "Sermaye", 500_000),
      ],
      0,
    );
    expect(b.assets.find((g) => g.label === "Hazır Değerler")?.amount).toBe(250_000);
    expect(b.assets.find((g) => g.label === "Ticari Alacaklar")?.amount).toBe(400_000);
    expect(b.assets.find((g) => g.label === "Stoklar")?.amount).toBe(150_000);
    expect(b.liabilities.find((g) => g.label === "Ticari Borçlar")?.amount).toBe(300_000);
    expect(b.liabilities.find((g) => g.label === "Ödenmiş Sermaye")?.amount).toBe(500_000);
    expect(b.totalAssets).toBe(800_000);
    expect(b.totalLiabilities).toBe(800_000);
    expect(b.balanced).toBe(true);
  });

  it("DÖNEM KÂRI ÖZKAYNAĞA TAŞINMAZSA BİLANÇO DENK GELMEZ", () => {
    // Bilanço yazan herkesin bir kez düştüğü tuzak: 6xx/7xx hesapları
    // bilançoda yoktur, kâr henüz 590'a aktarılmamıştır ve aradaki
    // fark tam olarak dönem kârı kadar olur.
    const rows = [
      row("102", "Bankalar", 300_000),
      row("320", "Satıcılar", 100_000),
      row("500", "Sermaye", 150_000),
    ];
    // Kâr eklenmezse 300.000 aktif, 250.000 pasif → 50.000 fark.
    expect(balanceSheet(rows, 0).balanced).toBe(false);
    // Kâr eklenince denk.
    const b = balanceSheet(rows, 50_000);
    expect(b.balanced).toBe(true);
    expect(b.liabilities.find((g) => g.label === "Dönem Net Kârı")?.amount).toBe(50_000);
  });

  it("KÂR 590'A AKTARILMIŞSA İKİ KEZ SAYILMAZ", () => {
    // Dönem sonu kaydı yapılmışsa kâr zaten mizanda durur; ayrıca
    // eklenirse özkaynak iki kat görünür.
    const b = balanceSheet(
      [
        row("102", "Bankalar", 300_000),
        row("320", "Satıcılar", 100_000),
        row("500", "Sermaye", 150_000),
        row("590", "Dönem Net Kârı", 50_000),
      ],
      50_000,
    );
    expect(b.totalLiabilities).toBe(300_000);
    expect(b.balanced).toBe(true);
  });

  it("dönem zararı da özkaynağı azaltır", () => {
    const b = balanceSheet(
      [row("102", "Bankalar", 80_000), row("500", "Sermaye", 100_000)],
      -20_000,
    );
    expect(b.liabilities.find((g) => g.label === "Dönem Net Zararı")?.amount).toBe(-20_000);
    expect(b.balanced).toBe(true);
  });

  it("BİRİKMİŞ AMORTİSMAN AKTİFİ AZALTIR", () => {
    /*
     * BU TEST BİR KEZ HATAYI KAÇIRDI ve bunu yazmaya değer kılan da o:
     * ilk hâli yalnızca `lines.length === 2` diyordu ve tutara hiç
     * bakmıyordu. Kod, 257'yi artı yazıyordu; test geçti, canlı demo
     * bilançosu tam olarak birikmiş amortismanın İKİ KATI kadar
     * (2.200.000) fark verdi. Sayıya bakmayan test, test değildir.
     */
    const b = balanceSheet(
      [
        row("255", "Demirbaşlar", 100_000),
        row("257", "Birikmiş Amortismanlar", 30_000),
        row("500", "Sermaye", 70_000),
      ],
      0,
    );
    const mdv = b.assets.find((g) => g.label === "Maddi Duran Varlıklar");
    expect(mdv?.lines.find((l) => l.code === "257")?.amount).toBe(-30_000);
    // 100.000 − 30.000 = 70.000 net defter değeri.
    expect(mdv?.amount).toBe(70_000);
    expect(b.totalAssets).toBe(70_000);
    expect(b.balanced).toBe(true);
  });

  it("DÖNEM ZARARI HESABI ÖZKAYNAĞI AZALTIR", () => {
    // 591 borç bakiyelidir ve pasifte durur; artı yazılsaydı özkaynak
    // zararla birlikte BÜYÜRDÜ.
    const b = balanceSheet(
      [
        row("102", "Bankalar", 80_000),
        row("500", "Sermaye", 100_000),
        row("591", "Dönem Net Zararı", 20_000),
      ],
      -20_000,
    );
    expect(b.liabilities.flatMap((g) => g.lines).find((l) => l.code === "591")?.amount).toBe(-20_000);
    expect(b.totalLiabilities).toBe(80_000);
    expect(b.balanced).toBe(true);
  });

  it("GELİR TABLOSU HESAPLARI BİLANÇOYA GİRMEZ", () => {
    const b = balanceSheet(
      [
        row("102", "Bankalar", 100_000),
        row("500", "Sermaye", 100_000),
        row("600", "Yurtiçi Satışlar", 900_000, "gelir"),
      ],
      0,
    );
    expect(b.totalAssets).toBe(100_000);
    expect(JSON.stringify(b)).not.toContain("600");
  });

  it("HİÇBİR HESAP SESSİZCE DÜŞMEZ", () => {
    // Gruplanamayan hesap kaybolsaydı bilanço denksiz görünür ama
    // nedeni bulunamazdı.
    const b = balanceSheet(
      [
        row("102", "Bankalar", 100_000),
        row("199", "Tanımsız Aktif", 5_000),
        row("500", "Sermaye", 105_000),
      ],
      0,
    );
    // 199 "Diğer Dönen Varlıklar" grubuna (19 ön eki) düşer.
    expect(b.totalAssets).toBe(105_000);
    expect(b.balanced).toBe(true);
  });

  it("gerçekten sınıflanamayan hesap AYRI BAŞLIKTA görünür", () => {
    const b = balanceSheet(
      [row("299", "Bilinmeyen", 7_000), row("500", "Sermaye", 7_000)],
      0,
    );
    const z = b.assets.find((g) => g.code === "Z");
    expect(z?.lines[0]?.code).toBe("299");
    expect(b.balanced).toBe(true);
  });

  it("kuruş yuvarlaması denkliği bozmaz", () => {
    const b = balanceSheet(
      [row("102", "Bankalar", 100_000.005), row("500", "Sermaye", 100_000)],
      0,
    );
    expect(b.balanced).toBe(true);
  });

  it("gerçek dengesizlik GİZLENMEZ", () => {
    const b = balanceSheet(
      [row("102", "Bankalar", 100_000), row("500", "Sermaye", 90_000)],
      0,
    );
    expect(b.balanced).toBe(false);
    expect(b.difference).toBe(10_000);
  });

  it("boş mizan denk sayılır", () => {
    const b = balanceSheet([], 0);
    expect(b.balanced).toBe(true);
    expect(b.totalAssets).toBe(0);
  });
});
