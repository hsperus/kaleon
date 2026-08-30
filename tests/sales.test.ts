/**
 * Satış zinciri: fiyatlandırma, KDV, belge akışı ve numaralandırma.
 *
 * Buradaki testlerin ortak derdi PARANIN VE MİKTARIN SESSİZCE KAYMASI.
 * Bir kuruşluk yuvarlama farkı ya da bir kalemin iki kez faturalanması,
 * aylar sonra mutabakatta ortaya çıkar ve o noktada hangi belgenin yanlış
 * olduğunu bulmak imkânsıza yakındır.
 */

import { describe, expect, it } from "vitest";
import {
  documentTotals,
  fromKurus,
  priceLine,
  toKurus,
  PricingError,
} from "../src/modules/sales/pricing.js";
import {
  assertDeliverable,
  assertDeliveryCancellable,
  assertInvoiceable,
  deliverableQty,
  deriveOrderStatus,
  invoiceableQty,
  isClosed,
  DocumentFlowError,
  type LineProgress,
} from "../src/modules/sales/o2c.js";
import {
  formatDocumentNo,
  parseDocumentNo,
  NumberingError,
} from "../src/modules/sales/numbering.js";

describe("kuruş yuvarlama", () => {
  it("yarımı yukarı yuvarlar", () => {
    expect(toKurus(1.005)).toBe(101);
    expect(toKurus(2.345)).toBe(235);
  });

  it("İKİLİK TABAN ARTIĞI BİR AŞAĞI YUVARLATMAZ", () => {
    // 0.615 ikilik tabanda 0.61499999999999999 olarak durur; naif
    // Math.round(0.615*100) = 61 verir ve her satırda 1 kuruş kaybolur.
    expect(toKurus(0.615)).toBe(62);
    expect(toKurus(8.475)).toBe(848);
  });

  it("NEGATİF TUTAR MUTLAK DEĞERE GÖRE YUVARLANIR — iade faturası", () => {
    // JavaScript'te Math.round(-2.5) === -2; muhasebede -3'tür.
    // -2.5 kuruş, muhasebe kuralıyla -3 kuruşa yuvarlanır.
    expect(toKurus(-0.025)).toBe(-3);
    expect(toKurus(-0.005)).toBe(-1);
    expect(toKurus(-2.5)).toBe(-250);
  });

  it("eksi sıfır üretmez", () => {
    expect(Object.is(toKurus(-0.001), 0)).toBe(true);
  });

  it("sonsuz ve NaN reddedilir", () => {
    expect(() => toKurus(Number.NaN)).toThrow(PricingError);
    expect(() => toKurus(Number.POSITIVE_INFINITY)).toThrow(PricingError);
  });
});

describe("satır fiyatlandırma", () => {
  it("brüt, iskonto, matrah ve KDV ayrı ayrı hesaplanır", () => {
    const a = priceLine({ quantity: 10, unitPrice: 250, discountPercent: 10, vatRate: 20 });
    expect(fromKurus(a.grossKurus)).toBe(2500);
    expect(fromKurus(a.discountKurus)).toBe(250);
    expect(fromKurus(a.netKurus)).toBe(2250);
    expect(fromKurus(a.vatKurus)).toBe(450);
    expect(fromKurus(a.totalKurus)).toBe(2700);
  });

  it("İSKONTO KDV MATRAHINI DÜŞÜRÜR — brüt üzerinden hesaplanmaz", () => {
    const a = priceLine({ quantity: 1, unitPrice: 1000, discountPercent: 50, vatRate: 20 });
    // Brüt üzerinden olsaydı 200 çıkardı; müşteriden 100 TL fazla KDV alınırdı.
    expect(fromKurus(a.vatKurus)).toBe(100);
  });

  it("ondalıklı miktar ve fiyat kuruşa oturur", () => {
    const a = priceLine({ quantity: 3.33, unitPrice: 12.37, vatRate: 10 });
    expect(a.grossKurus).toBe(4119); // 41.1921 → 41.19
    expect(a.vatKurus).toBe(412); // 4.119 → 4.12
  });

  it("GEÇERSİZ KDV ORANI REDDEDİLİR", () => {
    expect(() => priceLine({ quantity: 1, unitPrice: 100, vatRate: 18 })).toThrow(/Geçersiz KDV/);
  });

  it("%100 iskonto reddedilir", () => {
    expect(() =>
      priceLine({ quantity: 1, unitPrice: 100, discountPercent: 100, vatRate: 20 }),
    ).toThrow(PricingError);
  });

  it("negatif fiyat ve sıfır miktar reddedilir", () => {
    expect(() => priceLine({ quantity: 0, unitPrice: 10, vatRate: 20 })).toThrow(PricingError);
    expect(() => priceLine({ quantity: 1, unitPrice: -10, vatRate: 20 })).toThrow(PricingError);
  });
});

describe("belge toplamı", () => {
  const lines = [
    { vatRate: 20, amounts: priceLine({ quantity: 3, unitPrice: 33.33, vatRate: 20 }) },
    { vatRate: 20, amounts: priceLine({ quantity: 7, unitPrice: 11.11, vatRate: 20 }) },
    { vatRate: 1, amounts: priceLine({ quantity: 2, unitPrice: 49.99, vatRate: 1 }) },
  ];

  it("KDV ORANINA GÖRE KIRILIM ÜRETİR", () => {
    const t = documentTotals(lines);
    expect(t.vatBreakdown.map((b) => b.rate)).toEqual([1, 20]);
    expect(fromKurus(t.vatBreakdown[0]!.baseKurus)).toBe(99.98);
    expect(fromKurus(t.vatBreakdown[1]!.baseKurus)).toBe(177.76);
  });

  it("TOPLAM SATIRLARDAN TOPLANIR, YENİDEN HESAPLANMAZ", () => {
    const t = documentTotals(lines);
    const netSum = lines.reduce((s, l) => s + l.amounts.netKurus, 0);
    expect(t.netKurus).toBe(netSum);
    expect(t.totalKurus).toBe(t.netKurus + t.vatKurus);
  });

  it("boş belge sıfır toplar", () => {
    const t = documentTotals([]);
    expect(t.totalKurus).toBe(0);
    expect(t.vatBreakdown).toEqual([]);
  });
});

describe("sevkiyat miktarı", () => {
  const line = (over: Partial<LineProgress> = {}): LineProgress => ({
    lineNo: 1,
    itemCode: "M-1001",
    uom: "adet",
    orderedQty: 100,
    deliveredQty: 0,
    invoicedQty: 0,
    ...over,
  });

  it("kalan miktar hesaplanır", () => {
    expect(deliverableQty(line({ deliveredQty: 40 }))).toBe(60);
  });

  it("AŞIRI SEVKİYAT VARSAYILAN OLARAK KAPALIDIR", () => {
    expect(() => assertDeliverable(line(), 101)).toThrow(DocumentFlowError);
    expect(() => assertDeliverable(line(), 101)).toThrow(/aşırı sevkiyat kapalı/);
  });

  it("tolerans tanımlıysa o kadarına izin verir", () => {
    const l = line({ overDeliveryTolerance: 5 });
    expect(() => assertDeliverable(l, 105)).not.toThrow();
    expect(() => assertDeliverable(l, 106)).toThrow(/toleransı %5/);
  });

  it("HATA MESAJI SAYILARI İÇERİR", () => {
    try {
      assertDeliverable(line({ deliveredQty: 70 }), 40);
      throw new Error("beklenmedik");
    } catch (e) {
      const m = (e as Error).message;
      expect(m).toContain("sipariş 100 adet");
      expect(m).toContain("sevk edilen 70 adet");
      expect(m).toContain("kalan 30 adet");
    }
  });

  it("kısmi sevkiyat sonrası kalan tam sevk edilebilir", () => {
    const l = line({ deliveredQty: 30 });
    expect(() => assertDeliverable(l, 70)).not.toThrow();
  });
});

describe("faturalama miktarı", () => {
  const l: LineProgress = {
    lineNo: 1,
    itemCode: "M-1001",
    uom: "adet",
    orderedQty: 100,
    deliveredQty: 60,
    invoicedQty: 20,
  };

  it("faturalanabilir miktar SEVK EDİLENDEN türer", () => {
    expect(invoiceableQty(l)).toBe(40);
  });

  it("SEVK EDİLMEMİŞ MAL FATURALANAMAZ", () => {
    expect(() => assertInvoiceable(l, 41)).toThrow(/Sevk edilmemiş mal faturalanamaz/);
  });

  it("hiç sevk edilmemiş kalem faturalanamaz", () => {
    expect(() => assertInvoiceable({ ...l, deliveredQty: 0, invoicedQty: 0 }, 1)).toThrow(
      DocumentFlowError,
    );
  });
});

describe("sipariş durumu", () => {
  const l = (o: number, d: number, i: number, no = 1): LineProgress => ({
    lineNo: no,
    itemCode: `M-${no}`,
    uom: "adet",
    orderedQty: o,
    deliveredQty: d,
    invoicedQty: i,
  });

  it("hiç sevkiyat yoksa açık", () => {
    expect(deriveOrderStatus([l(100, 0, 0)])).toBe("open");
  });

  it("BİR KALEM SEVK EDİLDİYSE KISMİ — 'tamamlandı' göstermez", () => {
    expect(deriveOrderStatus([l(100, 100, 0, 1), l(50, 0, 0, 2)])).toBe("partially_delivered");
  });

  it("hepsi sevk edildiyse teslim edildi", () => {
    expect(deriveOrderStatus([l(100, 100, 0, 1), l(50, 50, 0, 2)])).toBe("delivered");
  });

  it("sevk edilenin tamamı faturalandıysa tamamlandı", () => {
    expect(deriveOrderStatus([l(100, 100, 100)])).toBe("completed");
  });

  it("KISMİ FATURA 'tamamlandı' SAYILMAZ", () => {
    expect(deriveOrderStatus([l(100, 100, 60)])).toBe("partially_invoiced");
  });

  it("iptal her şeyi ezer", () => {
    expect(deriveOrderStatus([l(100, 100, 100)], true)).toBe("cancelled");
  });

  it("kapalı sipariş yeni belge üretmez", () => {
    expect(isClosed("completed")).toBe(true);
    expect(isClosed("cancelled")).toBe(true);
    expect(isClosed("partially_invoiced")).toBe(false);
  });
});

describe("sevkiyat iptali", () => {
  it("FATURALANMIŞ SEVKİYAT İPTAL EDİLEMEZ", () => {
    expect(() => assertDeliveryCancellable(10)).toThrow(/iade faturası/);
  });

  it("faturalanmamış sevkiyat iptal edilebilir", () => {
    expect(() => assertDeliveryCancellable(0)).not.toThrow();
  });
});

describe("belge numarası", () => {
  const spec = { kind: "sales_invoice" as const, series: "FTR", year: 2026, padding: 6 };

  it("e-Fatura biçiminde üretir", () => {
    expect(formatDocumentNo(spec, 431)).toBe("FTR2026000431");
  });

  it("SERİ DOLDUĞUNDA SESSİZCE TAŞMAZ", () => {
    expect(() => formatDocumentNo({ ...spec, padding: 3 }, 1000)).toThrow(/doldu/);
  });

  it("geçersiz seri kodu reddedilir", () => {
    expect(() => formatDocumentNo({ ...spec, series: "fatura" }, 1)).toThrow(NumberingError);
  });

  it("sıfır ve negatif sıra reddedilir", () => {
    expect(() => formatDocumentNo(spec, 0)).toThrow(NumberingError);
  });

  it("üretilen numara geri ayrıştırılır", () => {
    expect(parseDocumentNo("FTR2026000431")).toEqual({
      series: "FTR",
      year: 2026,
      sequence: 431,
    });
  });

  it("tanınmayan numara null döner — tahmin edilmez", () => {
    expect(parseDocumentNo("2026/431")).toBe(null);
  });
});
