/**
 * Nakit akış projeksiyonu ve ödeme koşusu.
 *
 * BURADA ASIL TEST EDİLEN ŞEY DÜRÜSTLÜKTÜR. Projeksiyonun toplama
 * yapması kolay; zor olan, bilinmeyeni sıfır saymaması ve gecikmiş
 * alacağı "gelecek para" gibi göstermemesidir. Bu testlerin çoğu
 * rakamı değil, NEYİN DIŞARIDA BIRAKILDIĞINI kontrol eder.
 */

import { describe, expect, it } from "vitest";
import { projectCashFlow, type CashItem } from "../src/modules/finance/cashflow.js";
import {
  planPaymentRun,
  PaymentRunError,
  type PayableCandidate,
} from "../src/modules/finance/payment-run.js";

/** 2026-03-11, çarşamba. Hafta başı 2026-03-09 pazartesi. */
const BUGUN = new Date("2026-03-11T00:00:00.000Z");

function gun(offset: number): Date {
  return new Date(BUGUN.getTime() + offset * 86_400_000);
}

function alacak(no: string, amount: number, due: Date | null): CashItem {
  return { documentNo: no, partnerName: "Müşteri", amount, dueDate: due };
}

function borc(no: string, amount: number, due: Date | null): CashItem {
  return { documentNo: no, partnerName: "Tedarikçi", amount, dueDate: due };
}

describe("nakit akış projeksiyonu", () => {
  it("hafta pazartesiden başlar", () => {
    const p = projectCashFlow(BUGUN, 0, [], [], 2);
    expect(p.weeks[0]!.from).toBe("2026-03-09");
    expect(p.weeks[0]!.to).toBe("2026-03-15");
    expect(p.weeks[1]!.from).toBe("2026-03-16");
  });

  it("pazar günü de içinde bulunduğu haftaya düşer, sonrakine değil", () => {
    // 2026-03-15 pazar. getUTCDay() 0 döndürür; naif kod bunu haftanın
    // başı sanar ve belgeyi bir hafta ileri atardı.
    const p = projectCashFlow(new Date("2026-03-15T00:00:00.000Z"), 0, [], [], 1);
    expect(p.weeks[0]!.from).toBe("2026-03-09");
  });

  it("vadesi gelecek alacak ve borç doğru haftaya düşer", () => {
    const p = projectCashFlow(
      BUGUN,
      100_000,
      [alacak("SF-1", 50_000, gun(3))],
      [borc("AF-1", 20_000, gun(10))],
      3,
    );
    expect(p.weeks[0]!.inflow).toBe(50_000);
    expect(p.weeks[0]!.closing).toBe(150_000);
    expect(p.weeks[1]!.outflow).toBe(20_000);
    expect(p.weeks[1]!.closing).toBe(130_000);
  });

  it("GECİKMİŞ ALACAK projeksiyona girmez — ayrı gösterilir", () => {
    const p = projectCashFlow(BUGUN, 0, [alacak("SF-2", 90_000, gun(-40))], [], 2);
    expect(p.weeks[0]!.inflow).toBe(0);
    expect(p.weeks.every((w) => w.inflow === 0)).toBe(true);
    expect(p.overdueReceivables).toEqual({ count: 1, amount: 90_000 });
  });

  it("GECİKMİŞ BORÇ ilk haftanın çıkışıdır — borç ertelenmez", () => {
    const p = projectCashFlow(BUGUN, 100_000, [], [borc("AF-2", 30_000, gun(-5))], 2);
    expect(p.weeks[0]!.outflow).toBe(30_000);
    expect(p.weeks[0]!.closing).toBe(70_000);
    expect(p.overduePayables).toEqual({ count: 1, amount: 30_000 });
  });

  it("vadesi bilinmeyen belge hiçbir haftaya konmaz", () => {
    const p = projectCashFlow(
      BUGUN,
      0,
      [alacak("SF-3", 11_000, null)],
      [borc("AF-3", 7_000, null)],
      4,
    );
    expect(p.weeks.every((w) => w.inflow === 0 && w.outflow === 0)).toBe(true);
    expect(p.undated.receivableAmount).toBe(11_000);
    expect(p.undated.payableAmount).toBe(7_000);
  });

  it("ufkun dışındaki vade projeksiyona girmez", () => {
    const p = projectCashFlow(BUGUN, 0, [alacak("SF-4", 5_000, gun(200))], [], 4);
    expect(p.weeks.every((w) => w.inflow === 0)).toBe(true);
  });

  it("nakit eksiye düştüğü ilk haftayı bildirir", () => {
    const p = projectCashFlow(
      BUGUN,
      10_000,
      [],
      [borc("AF-4", 4_000, gun(2)), borc("AF-5", 9_000, gun(9))],
      3,
    );
    expect(p.weeks[0]!.closing).toBe(6_000);
    expect(p.shortfallWeek).toBe(2);
    expect(p.shortfallAmount).toBe(3_000);
  });

  it("açık yoksa null bildirir — sıfır değil", () => {
    const p = projectCashFlow(BUGUN, 1_000_000, [], [borc("AF-6", 1_000, gun(2))], 2);
    expect(p.shortfallWeek).toBeNull();
  });

  it("kuruş küsuratı haftalar boyunca birikmez", () => {
    const kalemler = Array.from({ length: 30 }, (_, i) => alacak(`SF-${i}`, 33.33, gun(1)));
    const p = projectCashFlow(BUGUN, 0, kalemler, [], 2);
    expect(p.weeks[0]!.inflow).toBe(999.9);
    expect(p.weeks[1]!.closing).toBe(999.9);
  });
});

function aday(
  no: string,
  amount: number,
  due: Date | null,
  extra: Partial<PayableCandidate> = {},
): PayableCandidate {
  return {
    documentNo: no,
    partnerId: "p-1",
    partnerName: "Tedarikçi A.Ş.",
    openAmount: amount,
    currency: "TRY",
    dueDate: due,
    matchStatus: "matched",
    ...extra,
  };
}

describe("ödeme koşusu", () => {
  it("en çok gecikmiş fatura önce önerilir", () => {
    const plan = planPaymentRun(BUGUN, 100_000, 0, [
      aday("AF-YENI", 10_000, gun(5)),
      aday("AF-ESKI", 10_000, gun(-30)),
      aday("AF-ORTA", 10_000, gun(-3)),
    ]);
    expect(plan.proposed.map((p) => p.documentNo)).toEqual(["AF-ESKI", "AF-ORTA", "AF-YENI"]);
    expect(plan.proposed[0]!.overdueDays).toBe(30);
    expect(plan.proposed[2]!.overdueDays).toBe(-5);
  });

  it("eşit gecikmede büyük tutar önce gelir", () => {
    const plan = planPaymentRun(BUGUN, 100_000, 0, [
      aday("AF-KUCUK", 1_000, gun(-10)),
      aday("AF-BUYUK", 50_000, gun(-10)),
    ]);
    expect(plan.proposed[0]!.documentNo).toBe("AF-BUYUK");
  });

  it("BLOKE fatura hiç önerilmez", () => {
    const plan = planPaymentRun(BUGUN, 100_000, 0, [
      aday("AF-BLOKE", 5_000, gun(-20), { matchStatus: "blocked" }),
      aday("AF-TEMIZ", 5_000, gun(-1)),
    ]);
    expect(plan.proposed.map((p) => p.documentNo)).toEqual(["AF-TEMIZ"]);
    expect(plan.blocked).toEqual([
      { documentNo: "AF-BLOKE", partnerName: "Tedarikçi A.Ş.", amount: 5_000 },
    ]);
  });

  it("kasa tabanının altına inilmez", () => {
    const plan = planPaymentRun(BUGUN, 100_000, 80_000, [
      aday("AF-1", 15_000, gun(-5)),
      aday("AF-2", 15_000, gun(-4)),
    ]);
    expect(plan.spendable).toBe(20_000);
    expect(plan.proposed.map((p) => p.documentNo)).toEqual(["AF-1"]);
    expect(plan.deferred[0]!.documentNo).toBe("AF-2");
    expect(plan.remainingCash).toBe(85_000);
  });

  it("kısmi ödeme yapılmaz — yetmeyen atlanır, sıradaki denenir", () => {
    const plan = planPaymentRun(BUGUN, 12_000, 0, [
      aday("AF-BUYUK", 20_000, gun(-30)),
      aday("AF-KUCUK", 8_000, gun(-2)),
    ]);
    expect(plan.proposed.map((p) => p.documentNo)).toEqual(["AF-KUCUK"]);
    expect(plan.deferred.map((p) => p.documentNo)).toEqual(["AF-BUYUK"]);
    expect(plan.deferred[0]!.reason).toContain("30 gündür gecikmiş");
  });

  it("vadesi bilinmeyen fatura sıraya girmez, ayrı listelenir", () => {
    const plan = planPaymentRun(BUGUN, 100_000, 0, [aday("AF-VADESIZ", 9_000, null)]);
    expect(plan.proposed).toEqual([]);
    expect(plan.undated).toEqual([
      { documentNo: "AF-VADESIZ", partnerName: "Tedarikçi A.Ş.", amount: 9_000 },
    ]);
  });

  it("yabancı para faturası TL sırasına karıştırılmaz", () => {
    const plan = planPaymentRun(BUGUN, 100_000, 0, [
      aday("AF-EUR", 1_000, gun(-50), { currency: "EUR" }),
      aday("AF-TRY", 1_000, gun(-1)),
    ]);
    expect(plan.proposed.map((p) => p.documentNo)).toEqual(["AF-TRY"]);
    expect(plan.foreignCurrency).toEqual([
      { documentNo: "AF-EUR", partnerName: "Tedarikçi A.Ş.", amount: 1_000, currency: "EUR" },
    ]);
  });

  it("negatif kasa tabanı ve negatif nakit reddedilir", () => {
    expect(() => planPaymentRun(BUGUN, 10, -1, [])).toThrow(PaymentRunError);
    expect(() => planPaymentRun(BUGUN, -1, 0, [])).toThrow(PaymentRunError);
  });

  it("taban nakitten büyükse hiçbir şey önerilmez, hata verilmez", () => {
    const plan = planPaymentRun(BUGUN, 5_000, 50_000, [aday("AF-1", 100, gun(-90))]);
    expect(plan.spendable).toBe(0);
    expect(plan.proposed).toEqual([]);
    expect(plan.deferred).toHaveLength(1);
  });

  it("önerilen toplam ve kalan nakit tutarlıdır", () => {
    const plan = planPaymentRun(BUGUN, 100_000, 10_000, [
      aday("AF-1", 30_000, gun(-9)),
      aday("AF-2", 25_000, gun(-8)),
    ]);
    expect(plan.proposedTotal).toBe(55_000);
    expect(plan.remainingCash).toBe(45_000);
    expect(plan.remainingCash - plan.cashFloor).toBe(plan.spendable - plan.proposedTotal);
  });
});
