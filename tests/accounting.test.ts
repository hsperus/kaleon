/**
 * Muhasebe: hesap planı, yevmiye fişi ve kayıt kuralları.
 *
 * Buradaki testlerin ortak derdi ŞU: mizanın denk çıkması, kaydın doğru
 * olduğu anlamına GELMEZ. Yanlış hesaba yazılmış bir fiş de denktir.
 * Bu yüzden testler yalnızca denkliği değil, HANGİ HESABA ne yazıldığını
 * sınıyor — çünkü mali müşavirin bakacağı yer orası.
 */

import { describe, expect, it } from "vitest";
import {
  account,
  accountClass,
  cogsAccountFor,
  signedBalance,
  stockAccountFor,
  AccountError,
  CHART,
} from "../src/modules/accounting/accounts.js";
import {
  balance,
  incomeSummary,
  reverseLines,
  trialBalance,
  JournalError,
} from "../src/modules/accounting/journal.js";
import {
  cashAccountFor,
  cogsLines,
  fxDifferenceLines,
  goodsReceiptLines,
  paymentLines,
  salesInvoiceLines,
  stockCountDifferenceLines,
} from "../src/modules/accounting/posting-rules.js";

describe("hesap planı", () => {
  it("TDHP kodları tanınır", () => {
    expect(account("120").name).toBe("Alıcılar");
    expect(account("600").name).toBe("Yurtiçi Satışlar");
    expect(account("391").name).toBe("Hesaplanan KDV");
  });

  it("PLAN DIŞI HESAP KULLANILAMAZ", () => {
    // Uydurma hesap, mali müşavirin ve vergi dairesinin okuyamayacağı
    // bir mizan üretir.
    expect(() => account("999")).toThrow(AccountError);
    expect(() => account("999")).toThrow(/Tek Düzen Hesap Planı/);
  });

  it("hesap kodları benzersizdir", () => {
    expect(new Set(CHART.map((a) => a.code)).size).toBe(CHART.length);
  });

  it("BAKİYE YÖNÜ HESABIN DOĞASINDAN GELİR", () => {
    // Varlık borçla artar, kaynak alacakla.
    expect(signedBalance(account("120"), 1000, 300)).toBe(700);
    expect(signedBalance(account("320"), 300, 1000)).toBe(700);
  });

  it("sınıf ilk haneden çıkar", () => {
    expect(accountClass("120")).toBe(1);
    expect(accountClass("600")).toBe(6);
  });

  it("STOK HESABI MALZEME TÜRÜNE GÖRE AYRILIR", () => {
    // Hepsi tek hesaba atılsaydı mizan denk kalır ama bilanço
    // "stoklarımız neyden oluşuyor" sorusuna cevap veremezdi.
    expect(stockAccountFor("hammadde")).toBe("150");
    expect(stockAccountFor("mamul")).toBe("152");
    expect(stockAccountFor("ticari_mal")).toBe("153");
  });

  it("satılan malın maliyeti üretilen ve alınan için ayrıdır", () => {
    expect(cogsAccountFor("mamul")).toBe("620");
    expect(cogsAccountFor("ticari_mal")).toBe("621");
  });
});

describe("yevmiye fişi", () => {
  const ok = [
    { accountCode: "120", debit: 1200, credit: 0, description: "a", partnerId: "p1" },
    { accountCode: "600", debit: 0, credit: 1000, description: "b" },
    { accountCode: "391", debit: 0, credit: 200, description: "c" },
  ];

  it("denk fiş kabul edilir", () => {
    const b = balance(ok);
    expect(b.totalDebit).toBe(1200);
    expect(b.totalCredit).toBe(1200);
    expect(b.lines.map((l) => l.lineNo)).toEqual([1, 2, 3]);
  });

  it("DENK OLMAYAN FİŞ KAYDEDİLEMEZ VE FARKI SÖYLER", () => {
    const bad = [...ok.slice(0, 2)];
    expect(() => balance(bad)).toThrow(/DENK DEĞİL/);
    expect(() => balance(bad)).toThrow(/fark 200/);
  });

  it("KURUŞ FARKI YAKALANIR — kayan noktada kaybolmaz", () => {
    // 0.1 + 0.2 !== 0.3; tam sayıda toplanmasaydı bu fiş denk sanılırdı.
    expect(() =>
      balance([
        { accountCode: "100", debit: 0.1, credit: 0, description: "a" },
        { accountCode: "102", debit: 0.2, credit: 0, description: "b" },
        { accountCode: "600", debit: 0, credit: 0.31, description: "c" },
      ]),
    ).toThrow(/DENK DEĞİL/);
    expect(() =>
      balance([
        { accountCode: "100", debit: 0.1, credit: 0, description: "a" },
        { accountCode: "102", debit: 0.2, credit: 0, description: "b" },
        { accountCode: "600", debit: 0, credit: 0.3, description: "c" },
      ]),
    ).not.toThrow();
  });

  it("BİR SATIR HEM BORÇ HEM ALACAK OLAMAZ", () => {
    expect(() =>
      balance([
        { accountCode: "100", debit: 5, credit: 3, description: "a" },
        { accountCode: "600", debit: 0, credit: 2, description: "b" },
      ]),
    ).toThrow(/tek yönlüdür/);
  });

  it("NEGATİF TUTAR REDDEDİLİR", () => {
    expect(() =>
      balance([
        { accountCode: "100", debit: -5, credit: 0, description: "a" },
        { accountCode: "600", debit: 0, credit: -5, description: "b" },
      ]),
    ).toThrow(/negatif/);
  });

  it("sıfır tutarlı satır yazılmaz", () => {
    expect(() =>
      balance([
        { accountCode: "100", debit: 0, credit: 0, description: "a" },
        { accountCode: "600", debit: 0, credit: 0, description: "b" },
      ]),
    ).toThrow(/sıfır/);
  });

  it("CARİ HESAPTA CARİ KİMLİĞİ ZORUNLUDUR", () => {
    // "Alıcılar 1.250.000 TL" satırı kimden alacaklı olduğumuzu söylemezse
    // mutabakat yapılamaz.
    expect(() =>
      balance([
        { accountCode: "120", debit: 100, credit: 0, description: "a" },
        { accountCode: "600", debit: 0, credit: 100, description: "b" },
      ]),
    ).toThrow(/cari kırılımı ister/);
  });

  it("tek satırlı fiş olmaz", () => {
    expect(() => balance([ok[0]!])).toThrow(JournalError);
  });

  it("TERS KAYIT TARAFLARI DEĞİŞTİRİR, NEGATİFLEMEZ", () => {
    // Negatiflenseydi mizanda "eksi borç" doğar ve toplamlar okunamazdı.
    const rev = reverseLines(ok);
    expect(rev[0]).toMatchObject({ accountCode: "120", debit: 0, credit: 1200 });
    expect(rev[1]).toMatchObject({ accountCode: "600", debit: 1000, credit: 0 });
    expect(rev[0]!.description).toContain("İPTAL");
    // Ters kayıt da denk olmalı.
    expect(() => balance(rev)).not.toThrow();
  });
});

describe("satış faturası kaydı", () => {
  const lines = salesInvoiceLines({
    documentNo: "FTR2026000001",
    partnerId: "p1",
    netAmount: 15_000,
    vatAmount: 3_000,
    totalAmount: 18_000,
  });

  it("alıcıya borç, satışa ve KDV'ye alacak", () => {
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ accountCode: "120", debit: 18_000 });
    expect(lines[1]).toMatchObject({ accountCode: "600", credit: 15_000 });
    expect(lines[2]).toMatchObject({ accountCode: "391", credit: 3_000 });
  });

  it("KDV CİROYA KARIŞMAZ", () => {
    // Toplamı tek kalemde gelire yazmak, devlete ait KDV'yi ciro gösterir.
    const revenue = lines.find((l) => l.accountCode === "600")!;
    expect(revenue.credit).toBe(15_000);
    expect(revenue.credit).not.toBe(18_000);
  });

  it("fiş denktir", () => {
    expect(balance(lines).totalDebit).toBe(18_000);
  });

  it("ihracatta 601 kullanılır", () => {
    const e = salesInvoiceLines({
      documentNo: "F1",
      partnerId: "p1",
      netAmount: 100,
      vatAmount: 0,
      totalAmount: 100,
      export: true,
    });
    expect(e[1]!.accountCode).toBe("601");
  });

  it("KDV SIFIRSA SATIR YAZILMAZ", () => {
    const e = salesInvoiceLines({
      documentNo: "F1",
      partnerId: "p1",
      netAmount: 100,
      vatAmount: 0,
      totalAmount: 100,
    });
    expect(e).toHaveLength(2);
  });
});

describe("satılan malın maliyeti", () => {
  it("maliyet stoktan çıkar, gidere yazılır", () => {
    const l = cogsLines({ documentNo: "IRS1", itemType: "mamul", value: 3_000 });
    expect(l[0]).toMatchObject({ accountCode: "620", debit: 3_000 });
    expect(l[1]).toMatchObject({ accountCode: "152", credit: 3_000 });
  });

  it("MALİYETİ BİLİNMEYEN SEVKİYAT KAYIT ÜRETMEZ", () => {
    // Sıfır maliyetle yazılsaydı o satış %100 kârlı görünürdü.
    expect(cogsLines({ documentNo: "IRS1", itemType: "mamul", value: null })).toEqual([]);
    expect(cogsLines({ documentNo: "IRS1", itemType: "mamul", value: 0 })).toEqual([]);
  });

  it("ticari malda 621/153 kullanılır", () => {
    const l = cogsLines({ documentNo: "IRS1", itemType: "ticari_mal", value: 500 });
    expect(l[0]!.accountCode).toBe("621");
    expect(l[1]!.accountCode).toBe("153");
  });
});

describe("mal kabulü kaydı", () => {
  const l = goodsReceiptLines({
    documentNo: "MK1",
    partnerId: "p2",
    itemType: "hammadde",
    netAmount: 10_000,
    vatAmount: 2_000,
  });

  it("stok ve indirilecek KDV borç, satıcı alacak", () => {
    expect(l[0]).toMatchObject({ accountCode: "150", debit: 10_000 });
    expect(l[1]).toMatchObject({ accountCode: "191", debit: 2_000 });
    expect(l[2]).toMatchObject({ accountCode: "320", credit: 12_000, partnerId: "p2" });
  });

  it("İNDİRİLECEK KDV STOK MALİYETİNE GİRMEZ", () => {
    // Girseydi stok %20 şişer, satılan malın maliyeti de yanlış çıkardı.
    expect(l[0]!.debit).toBe(10_000);
    expect(balance(l).totalDebit).toBe(12_000);
  });
});

describe("ödeme kaydı", () => {
  it("giden ödeme satıcı borcunu kapatır", () => {
    const l = paymentLines({
      documentNo: "ODM1",
      direction: "outgoing",
      partnerId: "p2",
      amount: 12_000,
      method: "havale",
    });
    expect(l[0]).toMatchObject({ accountCode: "320", debit: 12_000 });
    expect(l[1]).toMatchObject({ accountCode: "102", credit: 12_000 });
  });

  it("gelen tahsilat alıcı alacağını kapatır", () => {
    const l = paymentLines({
      documentNo: "ODM2",
      direction: "incoming",
      partnerId: "p1",
      amount: 18_000,
      method: "eft",
    });
    expect(l[0]).toMatchObject({ accountCode: "102", debit: 18_000 });
    expect(l[1]).toMatchObject({ accountCode: "120", credit: 18_000 });
  });

  it("ÇEK VE SENET NAKİT DEĞİLDİR", () => {
    expect(cashAccountFor("nakit", "outgoing")).toBe("100");
    expect(cashAccountFor("cek", "outgoing")).toBe("321");
    expect(cashAccountFor("cek", "incoming")).toBe("121");
    expect(cashAccountFor("havale", "outgoing")).toBe("102");
  });
});

describe("kur farkı", () => {
  it("LEHTE FARK SATIŞA DEĞİL 646'YA YAZILIR", () => {
    // 600'e yazılsaydı ciro kurdan şişer ve büyüme rakamı yalan söylerdi.
    const l = fxDifferenceLines({
      description: "FTR1",
      accountCode: "120",
      partnerId: "p1",
      difference: 500,
    });
    expect(l[0]).toMatchObject({ accountCode: "120", debit: 500 });
    expect(l[1]).toMatchObject({ accountCode: "646", credit: 500 });
  });

  it("aleyhte fark 656'ya yazılır", () => {
    const l = fxDifferenceLines({
      description: "FTR1",
      accountCode: "120",
      partnerId: "p1",
      difference: -500,
    });
    expect(l[0]).toMatchObject({ accountCode: "656", debit: 500 });
  });

  it("fark yoksa kayıt yok", () => {
    expect(
      fxDifferenceLines({ description: "x", accountCode: "120", partnerId: "p", difference: 0 }),
    ).toEqual([]);
  });
});

describe("sayım farkı", () => {
  it("EKSİK SAYIM MALİYETE DEĞİL 689'A YAZILIR", () => {
    // Maliyete yazılsaydı kaybolan mal satılmış gibi görünür ve fark gizlenirdi.
    const l = stockCountDifferenceLines({
      documentNo: "SAY1",
      itemType: "mamul",
      valueDifference: -1_500,
    });
    expect(l[0]).toMatchObject({ accountCode: "689", debit: 1_500 });
    expect(l[1]).toMatchObject({ accountCode: "152", credit: 1_500 });
  });

  it("fazla sayım stoğu artırır", () => {
    const l = stockCountDifferenceLines({
      documentNo: "SAY1",
      itemType: "mamul",
      valueDifference: 800,
    });
    expect(l[0]).toMatchObject({ accountCode: "152", debit: 800 });
    expect(l[1]).toMatchObject({ accountCode: "689", credit: 800 });
  });
});

describe("mizan", () => {
  const totals = [
    { accountCode: "120", debit: 18_000, credit: 0 },
    { accountCode: "600", debit: 0, credit: 15_000 },
    { accountCode: "391", debit: 0, credit: 3_000 },
    { accountCode: "620", debit: 9_000, credit: 0 },
    { accountCode: "152", debit: 0, credit: 9_000 },
  ];

  it("denk mizan denk raporlanır", () => {
    const t = trialBalance(totals);
    expect(t.totalDebit).toBe(27_000);
    expect(t.totalCredit).toBe(27_000);
    expect(t.balanced).toBe(true);
  });

  it("DENKSİZLİK SESSİZ KALMAZ", () => {
    // Sessizce gösterilen bozuk bir mizan, hiç gösterilmemesinden kötüdür.
    const t = trialBalance([...totals, { accountCode: "100", debit: 1, credit: 0 }]);
    expect(t.balanced).toBe(false);
  });

  it("bakiye hesabın yönüne göre işaretlenir", () => {
    const t = trialBalance(totals);
    expect(t.rows.find((r) => r.accountCode === "120")!.balance).toBe(18_000);
    expect(t.rows.find((r) => r.accountCode === "600")!.balance).toBe(15_000);
  });

  it("hesap koduna göre sıralanır", () => {
    const t = trialBalance(totals);
    expect(t.rows.map((r) => r.accountCode)).toEqual(["120", "152", "391", "600", "620"]);
  });

  it("GELİR TABLOSU BRÜT VE NET KÂRI AYIRIR", () => {
    const t = trialBalance(totals);
    const s = incomeSummary(t.rows);
    expect(s.revenue).toBe(15_000);
    expect(s.cogs).toBe(9_000);
    expect(s.grossProfit).toBe(6_000);
    expect(s.netProfit).toBe(6_000);
  });

  it("gider net kârı düşürür ama brüt kârı etkilemez", () => {
    const t = trialBalance([...totals, { accountCode: "632", debit: 2_000, credit: 0 }]);
    const s = incomeSummary(t.rows);
    expect(s.grossProfit).toBe(6_000);
    expect(s.netProfit).toBe(4_000);
  });

  it("SATIŞTAN İADE CİRODAN DÜŞÜLÜR", () => {
    const t = trialBalance([...totals, { accountCode: "610", debit: 1_000, credit: 0 }]);
    const s = incomeSummary(t.rows);
    expect(s.revenue).toBe(14_000);
  });
});
