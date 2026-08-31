/**
 * Banka mutabakatı ve ihtar.
 *
 * TEST EDİLEN ŞEY DOĞRU EŞLEŞMEYİ BULMAK DEĞİL — onu bulmak kolay.
 * Test edilen şey YANLIŞ eşleşmeyi ÖNERMEMEK: yanlış kapatılan bir
 * mutabakat, hiç yapılmamış mutabakattan kötüdür çünkü kapalı görünür.
 */

import { describe, expect, it } from "vitest";
import {
  suggestMatches,
  checkStatement,
  type StatementLine,
  type PaymentCandidate,
} from "../src/modules/finance/reconciliation.js";
import {
  planDunning,
  sortLevels,
  lateInterest,
  DunningError,
  type DunningLevel,
  type OverdueInvoice,
} from "../src/modules/finance/dunning.js";

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

function satir(over: Partial<StatementLine> = {}): StatementLine {
  return {
    id: "l1",
    lineNo: 1,
    valueDate: d("2026-08-20"),
    amount: 125_000,
    description: "HAVALE ORTHAUS MAKINA SAN TIC",
    counterparty: null,
    reference: null,
    ...over,
  };
}

function odeme(over: Partial<PaymentCandidate> = {}): PaymentCandidate {
  return {
    id: "p1",
    documentNo: "TAH-2026-0001",
    direction: "incoming",
    partnerName: "Orthaus Makina Sanayi ve Ticaret A.Ş.",
    amount: 125_000,
    currency: "TRY",
    paidAt: d("2026-08-20"),
    reference: null,
    alreadyMatched: false,
    ...over,
  };
}

describe("mutabakat önerisi", () => {
  it("tutar ve yön tutan ödemeyi önerir", () => {
    const s = suggestMatches(satir(), [odeme()]);
    expect(s).toHaveLength(1);
    expect(s[0]!.paymentId).toBe("p1");
    expect(s[0]!.reason.amountExact).toBe(true);
    expect(s[0]!.reason.nameHit).toBe(true);
  });

  it("TUTAR TUTMUYORSA ADAY DEĞİLDİR — ne kadar yakın olursa olsun", () => {
    // Bir kuruş fark bile ayrı bir olaydır: çoğu zaman masraf kesintisi.
    expect(suggestMatches(satir(), [odeme({ amount: 125_000.5 })])).toHaveLength(0);
    expect(suggestMatches(satir(), [odeme({ amount: 124_000 })])).toHaveLength(0);
  });

  it("float artığı eşleşmeyi bozmaz", () => {
    expect(suggestMatches(satir({ amount: 0.1 + 0.2 }), [odeme({ amount: 0.3 })])).toHaveLength(1);
  });

  it("YÖN TUTMUYORSA ADAY DEĞİLDİR", () => {
    // Müşteriden gelen para, tedarikçiye yapılan ödemeyle eşleşemez.
    expect(suggestMatches(satir(), [odeme({ direction: "outgoing" })])).toHaveLength(0);
    // Çıkış satırı tahsilatla eşleşemez.
    expect(suggestMatches(satir({ amount: -125_000 }), [odeme()])).toHaveLength(0);
  });

  it("çıkış satırı giden ödemeyle eşleşir", () => {
    const s = suggestMatches(satir({ amount: -125_000 }), [odeme({ direction: "outgoing" })]);
    expect(s).toHaveLength(1);
  });

  it("zaten eşleşmiş ödeme yeniden önerilmez", () => {
    expect(suggestMatches(satir(), [odeme({ alreadyMatched: true })])).toHaveLength(0);
  });

  it("farklı para birimi aday değildir", () => {
    expect(suggestMatches(satir(), [odeme({ currency: "EUR" })])).toHaveLength(0);
  });

  it("on günden uzak tarih aday değildir", () => {
    expect(suggestMatches(satir(), [odeme({ paidAt: d("2026-08-05") })])).toHaveLength(0);
    expect(suggestMatches(satir(), [odeme({ paidAt: d("2026-08-14") })])).toHaveLength(1);
  });

  it("dekont numarası geçiyorsa skor yükselir ve öne çıkar", () => {
    const s = suggestMatches(
      satir({ description: "EFT DK2026118 MUHTELIF" }),
      [
        odeme({ id: "p1", documentNo: "T-1", reference: "DK2026118" }),
        odeme({ id: "p2", documentNo: "T-2", reference: "BASKA" }),
      ],
    );
    expect(s[0]!.paymentId).toBe("p1");
    expect(s[0]!.reason.referenceHit).toBe(true);
    expect(s[0]!.score).toBeGreaterThan(s[1]!.score);
  });

  it("ÇOK KISA REFERANS TESADÜFEN EŞLEŞMEZ", () => {
    // "12" her açıklamada geçebilir; referans sayılmaz.
    const s = suggestMatches(satir({ description: "HAVALE 12 NOLU" }), [odeme({ reference: "12" })]);
    expect(s[0]!.reason.referenceHit).toBe(false);
  });

  it("TÜZEL EKLER İSİM EŞLEŞMESİ SAYILMAZ", () => {
    // "A.Ş." ve "Sanayi" neredeyse her unvanda var; onlara bakarak
    // eşleştirmek her cariyi her satıra bağlardı.
    const s = suggestMatches(
      satir({ description: "HAVALE SANAYI VE TICARET A S ODEME" }),
      [odeme({ partnerName: "Zerey Metal Sanayi ve Ticaret A.Ş." })],
    );
    expect(s[0]!.reason.nameHit).toBe(false);
  });

  it("Türkçe karakteri bozulmuş ekstrede ad yine bulunur", () => {
    const s = suggestMatches(
      satir({ description: "HAVALE CELIK DOKUM ODEMESI" }),
      [odeme({ partnerName: "Çelik Döküm A.Ş." })],
    );
    expect(s[0]!.reason.nameHit).toBe(true);
  });

  it("hiçbir ipucu yoksa uyarır — sessizce yüksek skor vermez", () => {
    const s = suggestMatches(satir({ description: "MUHTELIF TAHSILAT" }), [
      odeme({ partnerName: "Zerey Metal A.Ş." }),
    ]);
    expect(s[0]!.explanation).toContain("dikkatle bakın");
    expect(s[0]!.score).toBeLessThan(60);
  });
});

describe("ekstre bütünlüğü", () => {
  it("açılış + hareket = kapanış", () => {
    const r = checkStatement(100_000, 125_000, [{ amount: 40_000 }, { amount: -15_000 }]);
    expect(r.ok).toBe(true);
    expect(r.movement).toBe(25_000);
    expect(r.difference).toBe(0);
  });

  it("TUTMUYORSA FARKI SÖYLER — ekstre eksik ayrıştırılmıştır", () => {
    const r = checkStatement(100_000, 130_000, [{ amount: 25_000 }]);
    expect(r.ok).toBe(false);
    expect(r.difference).toBe(5_000);
  });

  it("kuruş artığı ekstreyi bozuk saymaz", () => {
    const r = checkStatement(0, 0.3, [{ amount: 0.1 }, { amount: 0.2 }]);
    expect(r.ok).toBe(true);
  });
});

const KADEMELER: DunningLevel[] = [
  { level: 1, minOverdueDays: 15, label: "Hatırlatma", interestRate: null },
  { level: 2, minOverdueDays: 45, label: "İkinci ihtar", interestRate: 36 },
  { level: 3, minOverdueDays: 90, label: "Son ihtar", interestRate: 48 },
];

function fatura(over: Partial<OverdueInvoice> = {}): OverdueInvoice {
  return {
    documentNo: "SF-1",
    partnerId: "c1",
    partnerName: "Kuehne + Nagel",
    openAmount: 50_000,
    currency: "TRY",
    dueDate: d("2026-07-01"),
    ...over,
  };
}

const BUGUN = d("2026-08-31");

describe("ihtar planı", () => {
  it("kademeler ARTAN olmalı — değilse reddeder", () => {
    expect(() =>
      sortLevels([
        { level: 1, minOverdueDays: 30, label: "a", interestRate: null },
        { level: 2, minOverdueDays: 15, label: "b", interestRate: null },
      ]),
    ).toThrow(DunningError);
  });

  it("hiç kademe tanımlı değilse plan yapmaz", () => {
    expect(() => planDunning(BUGUN, [fatura()], [])).toThrow(DunningError);
  });

  it("en eski gecikmeye göre kademe seçer", () => {
    // 2026-07-01 vadesi → 61 gün gecikme → 2. kademe.
    const p = planDunning(BUGUN, [fatura()], KADEMELER);
    expect(p.candidates[0]!.level).toBe(2);
    expect(p.candidates[0]!.oldestOverdueDays).toBe(61);
  });

  it("BİR CARİYE BİR MEKTUP — faturalar tek ihtarda toplanır", () => {
    const p = planDunning(
      BUGUN,
      [
        fatura({ documentNo: "SF-1", dueDate: d("2026-07-01"), openAmount: 50_000 }),
        fatura({ documentNo: "SF-2", dueDate: d("2026-08-10"), openAmount: 30_000 }),
      ],
      KADEMELER,
    );
    expect(p.candidates).toHaveLength(1);
    expect(p.candidates[0]!.totalAmount).toBe(80_000);
    // En eski önce: mektupta o sırayla okunmalı.
    expect(p.candidates[0]!.invoiceNos).toEqual(["SF-1", "SF-2"]);
  });

  it("henüz kademeye girmeyen ayrı sayılır — sessizce düşmez", () => {
    const p = planDunning(BUGUN, [fatura({ dueDate: d("2026-08-25"), openAmount: 9_000 })], KADEMELER);
    expect(p.candidates).toHaveLength(0);
    expect(p.tooEarly).toEqual({ count: 1, amount: 9_000 });
  });

  it("vadesi gelmemiş fatura hiç değerlendirilmez", () => {
    const p = planDunning(BUGUN, [fatura({ dueDate: d("2026-09-30") })], KADEMELER);
    expect(p.candidates).toHaveLength(0);
    expect(p.tooEarly.count).toBe(0);
  });

  it("AYNI KADEME İKİ KEZ GÖNDERİLMEZ", () => {
    const onceki = new Map([["c1", 2]]);
    const p = planDunning(BUGUN, [fatura()], KADEMELER, onceki);
    expect(p.candidates).toHaveLength(0);
  });

  it("kademe AĞIRLAŞTIYSA yeni mektup çıkar", () => {
    const onceki = new Map([["c1", 1]]);
    const p = planDunning(BUGUN, [fatura()], KADEMELER, onceki);
    expect(p.candidates).toHaveLength(1);
    expect(p.candidates[0]!.level).toBe(2);
    expect(p.candidates[0]!.previousLevel).toBe(1);
  });

  it("gecikme faizi BASİT hesaplanır", () => {
    // 100.000 ₺, 61 gün, yıllık %36 → 100000 * .36 * 61 / 365
    expect(lateInterest(100_000, 61, 36)).toBe(6_016.44);
  });

  it("faiz oranı tanımsız kademede faiz sıfırdır", () => {
    expect(lateInterest(100_000, 61, null)).toBe(0);
    const p = planDunning(BUGUN, [fatura({ dueDate: d("2026-08-01") })], KADEMELER);
    expect(p.candidates[0]!.level).toBe(1);
    expect(p.candidates[0]!.interest).toBe(0);
  });

  it("en ağır durum başta listelenir", () => {
    const p = planDunning(
      BUGUN,
      [
        fatura({ partnerId: "c1", partnerName: "Hafif", dueDate: d("2026-08-10") }),
        fatura({ partnerId: "c2", partnerName: "Ağır", dueDate: d("2026-04-01") }),
      ],
      KADEMELER,
    );
    expect(p.candidates[0]!.partnerName).toBe("Ağır");
    expect(p.candidates[0]!.level).toBe(3);
  });
});
