/**
 * Belge katmanının sayısal mantığı.
 *
 * BURADAKİ HATA KÂĞIDA BASILIR. Ekrandaki yanlış bir toplam düzeltilir;
 * imzalanıp bankaya giden belgedeki yanlış toplam düzeltilmez. Bu
 * yüzden "eksik veriyi sıfır sayma" davranışı ayrıca sınanıyor.
 */

import { describe, expect, it } from "vitest";
import { titleFor } from "../app/rich-text.js";
import { asAttachedDoc } from "../app/uygulama/page.js";
import { parseBlocks } from "../src/ui/markdown.js";
import { parseTurkishNumber } from "../app/api/export/route.js";

describe("belge başlığı", () => {
  it("en yakın üstteki başlığı alır", () => {
    const blocks = parseBlocks(
      "## Cari Mizan\n\nAçıklama satırı.\n\n| Hesap | Borç |\n| --- | --- |\n| A | 1 |",
    );
    const i = blocks.findIndex((b) => b.kind === "table");
    expect(titleFor(blocks, i)).toBe("Cari Mizan");
  });

  it("İKİ TABLO BİRBİRİNİN BAŞLIĞINI ÇALMAZ", () => {
    // İkinci tablonun kendi başlığı yoksa birincininkini almamalı;
    // aksi hâlde iki farklı dosya aynı adla iner.
    const blocks = parseBlocks(
      "## TL Bakiyeler\n\n| Hesap | Borç |\n| --- | --- |\n| A | 1 |\n\n| Banka | Tutar |\n| --- | --- |\n| B | 2 |",
    );
    const tables = blocks.map((b, i) => [b, i] as const).filter(([b]) => b.kind === "table");
    expect(titleFor(blocks, tables[0]![1])).toBe("TL Bakiyeler");
    expect(titleFor(blocks, tables[1]![1])).toBe("Banka listesi");
  });

  it("başlık yoksa ilk sütundan ad üretir", () => {
    const blocks = parseBlocks("| Tedarikçi | Risk |\n| --- | --- |\n| X | 3 |");
    expect(titleFor(blocks, 0)).toBe("Tedarikçi listesi");
  });
});

describe("dışa aktarma uç noktası — sayı çevirimi", () => {
  it("hücreyi Excel'in toplayabileceği sayıya çevirir", () => {
    expect(parseTurkishNumber("12.400.000,00")).toBe(12400000);
    expect(parseTurkishNumber("156.000 TL")).toBe(156000);
  });

  it("KALIN YAZILMIŞ TOPLAM SAYI KALIR", () => {
    // Model toplam satırını **kalın** yazar. Yıldızlar sayıyı metne
    // çevirseydi Excel'de toplam sütunu toplanamazdı.
    expect(parseTurkishNumber("**25.200.000**")).toBe(25200000);
  });

  it("çevrilemeyen hücre METİN kalır", () => {
    // null dönmesi, uç noktanın hücreyi metin yazacağı anlamına gelir.
    expect(parseTurkishNumber("bilinmiyor")).toBeNull();
    expect(parseTurkishNumber("—")).toBeNull();
  });
});

describe("belge tip koruması", () => {
  const invoice = {
    kind: "invoice",
    invoice: {
      documentNo: "FTR2026000001",
      lines: [],
      totalAmount: 1000,
      currency: "TRY",
      customer: { legalName: "X A.Ş." },
    },
  };

  it("fatura yükü tanınır", () => {
    expect(asAttachedDoc(invoice)?.kind).toBe("invoice");
  });

  it("irsaliye yükü tanınır", () => {
    const d = asAttachedDoc({
      kind: "despatch",
      despatch: { documentNo: "IRS2026000001", lines: [], customer: { legalName: "X A.Ş." } },
    });
    expect(d?.kind).toBe("despatch");
  });

  it("BİÇİM UYMUYORSA BELGE GÖSTERİLMEZ", () => {
    // Sunucu biçimi değişirse arayüz çalışma anında patlamamalı;
    // belge düşer, cevabın kendisi görünmeye devam eder.
    expect(asAttachedDoc(null)).toBeNull();
    expect(asAttachedDoc({ kind: "invoice" })).toBeNull();
    expect(asAttachedDoc({ kind: "invoice", invoice: { documentNo: "X" } })).toBeNull();
    expect(asAttachedDoc({ ...invoice, invoice: { ...invoice.invoice, totalAmount: "1000" } })).toBeNull();
    expect(asAttachedDoc({ kind: "başka", invoice: invoice.invoice })).toBeNull();
  });

  it("TUTARI OLMAYAN İRSALİYE REDDEDİLMEZ", () => {
    // İrsaliyede tutar yoktur; fatura kuralını ona uygulamak, geçerli
    // bir belgeyi hiç göstermemek olurdu.
    const d = asAttachedDoc({
      kind: "despatch",
      despatch: { documentNo: "IRS-1", lines: [{ lineNo: 1 }], customer: { legalName: "Y" } },
    });
    expect(d).not.toBeNull();
  });
});

describe("bilanço belgesi tip koruması", () => {
  const sheet = {
    kind: "balance-sheet",
    asOf: "2026-08-29",
    periodFrom: "2026-01-01",
    assets: [],
    liabilities: [],
    totalAssets: 100,
    totalLiabilities: 100,
    periodResult: 0,
    balanced: true,
    difference: 0,
  };

  it("bilanço yükü tanınır", () => {
    expect(asAttachedDoc(sheet)?.kind).toBe("balance-sheet");
  });

  it("eksik alanlı bilanço gösterilmez", () => {
    expect(asAttachedDoc({ ...sheet, assets: undefined })).toBeNull();
    expect(asAttachedDoc({ ...sheet, totalAssets: "100" })).toBeNull();
  });

  it("DENK OLMAYAN BİLANÇO DA GÖSTERİLİR", () => {
    // Gizlenseydi kullanıcı sorunu hiç görmezdi; belge üzerinde
    // uyarıyla birlikte gösterilir.
    const d = asAttachedDoc({ ...sheet, balanced: false, difference: 500 });
    expect(d?.kind).toBe("balance-sheet");
  });
});

describe("mutabakat mektubu tip koruması", () => {
  const st = {
    kind: "statement",
    from: "2026-01-01",
    to: "2026-08-29",
    partnerId: "p1",
    partnerName: "Daimler A.Ş.",
    partnerCode: "C-1001",
    partnerAddress: null,
    partnerTaxOffice: null,
    openingBalance: 0,
    closingBalance: 444816,
    movements: [],
  };

  it("mutabakat yükü tanınır", () => {
    expect(asAttachedDoc(st)?.kind).toBe("statement");
  });

  it("HAREKETSİZ EKSTRE DE BELGEDİR", () => {
    // Hareketi olmayan bir cari için de mutabakat gönderilir:
    // "bakiyeniz sıfır" da bir mutabakattır.
    expect(asAttachedDoc({ ...st, closingBalance: 0 })?.kind).toBe("statement");
  });

  it("eksik alanlı ekstre gösterilmez", () => {
    expect(asAttachedDoc({ ...st, movements: undefined })).toBeNull();
    expect(asAttachedDoc({ ...st, closingBalance: "444816" })).toBeNull();
  });
});

describe("bordro pusulası tip koruması", () => {
  const slip = {
    kind: "payslip",
    payslip: {
      employeeCode: "P-002",
      employeeName: "Mehmet Kaya",
      department: "Muhasebe",
      position: "Muhasebe Müdürü",
      period: "2026-08-01",
      grossSalary: 135_000,
      bonus: 0,
      totalGross: 135_000,
      sgkBase: 135_000,
      employeeSgk: 18_900,
      employeeUnemployment: 1_350,
      taxBase: 114_750,
      cumulativeBefore: 803_250,
      cumulativeAfter: 918_000,
      grossIncomeTax: 30_982.5,
      incomeTaxExemption: 5_615.1,
      incomeTax: 25_367.4,
      stampDuty: 774.55,
      totalDeductions: 46_391.35,
      netSalary: 88_608.65,
      employerSgk: 28_012.5,
      employerUnemployment: 2_700,
      employerCost: 165_712.5,
    },
  };

  it("bordro yükü tanınır", () => {
    expect(asAttachedDoc(slip)?.kind).toBe("payslip");
  });

  it("NET SIFIR OLAN BORDRO DA BELGEDİR", () => {
    // Ücretsiz izinli bir ay net sıfır olabilir; belge yine düzenlenir.
    const d = asAttachedDoc({ ...slip, payslip: { ...slip.payslip, netSalary: 0 } });
    expect(d?.kind).toBe("payslip");
  });

  it("eksik alanlı bordro gösterilmez", () => {
    expect(asAttachedDoc({ ...slip, payslip: { ...slip.payslip, netSalary: "88608" } })).toBeNull();
    expect(asAttachedDoc({ ...slip, payslip: { ...slip.payslip, period: undefined } })).toBeNull();
    expect(asAttachedDoc({ kind: "payslip" })).toBeNull();
  });
});
