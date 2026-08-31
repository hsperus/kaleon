/**
 * Maliyet muhasebesi — masraf merkezi ve bütçe.
 *
 * BU TESTLERİN ÇOĞU YANLIŞ ALARMI ÖNLEMEYE DAİR. Bir bütçe raporu
 * her yıl birkaç kez yanlış "aşıldı" derse, birkaç yanlış alarmdan
 * sonra kimse ona bakmaz — ve gerçek aşım da görülmez.
 */

import { describe, expect, it } from "vitest";
import {
  budgetVsActual,
  descendantsOf,
  assertNoCycle,
  isExpenseAccount,
  accountGroup,
  ControllingError,
  type CostCenterNode,
  type BudgetLine,
  type ActualLine,
} from "../src/modules/accounting/controlling.js";

const MERKEZLER: CostCenterNode[] = [
  { code: "URT", name: "Üretim", parentCode: null, isActive: true },
  { code: "URT-KYN", name: "Kaynakhane", parentCode: "URT", isActive: true },
  { code: "URT-MNT", name: "Montaj", parentCode: "URT", isActive: true },
  { code: "IDR", name: "İdari", parentCode: null, isActive: true },
];

describe("hesap sınıflandırma", () => {
  it("gider hesapları 6 ve 7 ile başlar", () => {
    expect(isExpenseAccount("770")).toBe(true);
    expect(isExpenseAccount("621")).toBe(true);
    // Bilanço hesabına masraf merkezi yazmak raporu ikiye böler.
    expect(isExpenseAccount("102")).toBe(false);
    expect(isExpenseAccount("320")).toBe(false);
  });

  it("bütçe GRUP seviyesinde: ilk üç hane", () => {
    expect(accountGroup("770.01.003")).toBe("770");
  });
});

describe("masraf merkezi ağacı", () => {
  it("üst merkez alt merkezleri kapsar", () => {
    expect([...descendantsOf("URT", MERKEZLER)].sort()).toEqual(["URT", "URT-KYN", "URT-MNT"]);
  });

  it("yaprak merkez yalnızca kendisidir", () => {
    expect(descendantsOf("IDR", MERKEZLER)).toEqual(["IDR"]);
  });

  it("DÖNGÜ REDDEDİLİR — yoksa rapor sonsuza kadar döner", () => {
    const dongulu: CostCenterNode[] = [
      { code: "A", name: "A", parentCode: "B", isActive: true },
      { code: "B", name: "B", parentCode: "A", isActive: true },
    ];
    expect(() => assertNoCycle(dongulu)).toThrow(ControllingError);
    expect(() => descendantsOf("A", dongulu)).toThrow(ControllingError);
  });
});

const BUTCE: BudgetLine[] = [
  { costCenterCode: "URT", accountGroup: "730", year: 2026, month: null, amount: 1_200_000 },
  { costCenterCode: "IDR", accountGroup: "770", year: 2026, month: 3, amount: 100_000 },
];

const gercek = (o: Partial<ActualLine> = {}): ActualLine => ({
  costCenterCode: "URT",
  accountCode: "730.01",
  amount: 500_000,
  month: 3,
  ...o,
});

describe("bütçe–gerçekleşme", () => {
  it("bütçe içinde kalan 'none' durumundadır", () => {
    const r = budgetVsActual(2026, null, MERKEZLER, BUTCE, [gercek()]);
    const satir = r.rows.find((x) => x.costCenterCode === "URT")!;
    expect(satir.status).toBe("none");
    expect(satir.variance).toBe(700_000);
    expect(satir.usedPercent).toBe(41.7);
  });

  it("AŞIM negatif sapmadır ve başta listelenir", () => {
    const r = budgetVsActual(2026, null, MERKEZLER, BUTCE, [gercek({ amount: 1_500_000 })]);
    expect(r.rows[0]!.status).toBe("over");
    expect(r.rows[0]!.variance).toBe(-300_000);
    expect(r.overCount).toBe(1);
  });

  it("%90'ı geçen 'watch' — aşmadan uyarır", () => {
    const r = budgetVsActual(2026, null, MERKEZLER, BUTCE, [gercek({ amount: 1_100_000 })]);
    expect(r.rows.find((x) => x.costCenterCode === "URT")!.status).toBe("watch");
  });

  it("BÜTÇESİ OLMAYAN GİDER 'unbudgeted' — %∞ aşım DEĞİL", () => {
    // Sıfır bütçe sayılıp kırmızıya boyamak, gerçek aşımları
    // görünmez kılar.
    const r = budgetVsActual(2026, null, MERKEZLER, [], [gercek({ amount: 90_000 })]);
    const satir = r.rows[0]!;
    expect(satir.status).toBe("unbudgeted");
    expect(satir.budget).toBeNull();
    expect(satir.usedPercent).toBeNull();
    expect(r.unbudgetedCount).toBe(1);
    expect(r.unbudgetedAmount).toBe(90_000);
    expect(r.overCount).toBe(0);
  });

  it("YILLIK BÜTÇE AYA BÖLÜNMEZ", () => {
    /*
     * Yıllık 1.200.000 ₺ bütçe, Mart sorgusunda 100.000'e
     * bölünseydi 500.000 ₺'lik bir bakım gideri "beş kat aşım"
     * görünürdü. Oysa bu mevsimsellik, sapma değil.
     */
    const r = budgetVsActual(2026, 3, MERKEZLER, BUTCE, [gercek()]);
    const satir = r.rows.find((x) => x.costCenterCode === "URT")!;
    expect(satir.budget).toBeNull();
    expect(satir.status).toBe("unbudgeted");
  });

  it("aylık bütçe yalnızca kendi ayında karşılaştırılır", () => {
    const mart = budgetVsActual(2026, 3, MERKEZLER, BUTCE, [
      gercek({ costCenterCode: "IDR", accountCode: "770.01", amount: 80_000, month: 3 }),
    ]);
    expect(mart.rows.find((x) => x.costCenterCode === "IDR")!.budget).toBe(100_000);

    const nisan = budgetVsActual(2026, 4, MERKEZLER, BUTCE, [
      gercek({ costCenterCode: "IDR", accountCode: "770.01", amount: 80_000, month: 4 }),
    ]);
    expect(nisan.rows.find((x) => x.costCenterCode === "IDR")!.budget).toBeNull();
  });

  it("başka yılın bütçesi karışmaz", () => {
    const r = budgetVsActual(2025, null, MERKEZLER, BUTCE, [gercek()]);
    expect(r.rows[0]!.budget).toBeNull();
  });

  it("sıfır bütçede harcama varsa oran tanımsız, durum aşım", () => {
    const sifir: BudgetLine[] = [
      { costCenterCode: "URT", accountGroup: "730", year: 2026, month: null, amount: 0 },
    ];
    const r = budgetVsActual(2026, null, MERKEZLER, sifir, [gercek({ amount: 10 })]);
    expect(r.rows[0]!.status).toBe("over");
    expect(r.rows[0]!.usedPercent).toBeNull();
  });

  it("harcaması olmayan bütçe de raporda görünür — kullanılmamış bütçe bilgidir", () => {
    const r = budgetVsActual(2026, null, MERKEZLER, BUTCE, []);
    expect(r.rows).toHaveLength(2);
    expect(r.totalActual).toBe(0);
    expect(r.totalBudget).toBe(1_300_000);
  });

  it("tanımsız merkez koduna düşen gider gizlenmez", () => {
    const r = budgetVsActual(2026, null, MERKEZLER, [], [gercek({ costCenterCode: "YOK" })]);
    expect(r.rows[0]!.costCenterName).toBe("(tanımsız merkez)");
  });
});
