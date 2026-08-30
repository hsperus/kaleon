/**
 * Fiyat koşulları ve teklif zinciri.
 *
 * Fiyatın en sinsi hatası TUTARSIZLIKTIR: aynı sipariş iki kez
 * hesaplandığında iki farklı fiyat çıkması. Bu yüzden testlerin ağırlığı
 * "en özgül koşul kazanır" kuralında — sıralama belirsizse fiyat da
 * belirsizdir.
 */

import { describe, expect, it } from "vitest";
import {
  matches,
  priceFor,
  specificity,
  PricingConditionError,
  type Condition,
  type PricingRequest,
} from "../src/modules/sales/pricing-conditions.js";

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

const base: Omit<Condition, "id" | "kind" | "value"> = {
  partnerId: null,
  itemCode: null,
  partnerGroup: null,
  minQuantity: 0,
  currency: "TRY",
  validFrom: d("2026-01-01"),
  validTo: null,
};

const cond = (over: Partial<Condition> & { id: string; kind: Condition["kind"]; value: number }): Condition => ({
  ...base,
  ...over,
});

const req: PricingRequest = {
  itemCode: "MM-500",
  partnerId: "P-1",
  quantity: 10,
  currency: "TRY",
  on: d("2026-06-15"),
};

describe("koşul eşleşmesi", () => {
  it("boş alan HERKES demektir", () => {
    expect(matches(cond({ id: "c1", kind: "fiyat", value: 900 }), req)).toBe(true);
  });

  it("başka müşterinin koşulu eşleşmez", () => {
    expect(matches(cond({ id: "c1", kind: "fiyat", value: 900, partnerId: "P-9" }), req)).toBe(false);
  });

  it("başka malzemenin koşulu eşleşmez", () => {
    expect(matches(cond({ id: "c1", kind: "fiyat", value: 900, itemCode: "MM-999" }), req)).toBe(false);
  });

  it("MİKTAR KADEMESİ ALTINDA EŞLEŞMEZ", () => {
    expect(matches(cond({ id: "c1", kind: "fiyat", value: 800, minQuantity: 50 }), req)).toBe(false);
    expect(
      matches(cond({ id: "c1", kind: "fiyat", value: 800, minQuantity: 50 }), { ...req, quantity: 60 }),
    ).toBe(true);
  });

  it("PARA BİRİMİ FARKLIYSA EŞLEŞMEZ", () => {
    // EUR fiyatı TL siparişe uygulanamaz; kur çevrimi ayrı bir karardır.
    expect(matches(cond({ id: "c1", kind: "fiyat", value: 30, currency: "EUR" }), req)).toBe(false);
  });

  it("SÜRESİ GEÇMİŞ KOŞUL EŞLEŞMEZ", () => {
    expect(
      matches(cond({ id: "c1", kind: "fiyat", value: 900, validTo: d("2026-05-31") }), req),
    ).toBe(false);
  });

  it("başlamamış koşul eşleşmez", () => {
    expect(
      matches(cond({ id: "c1", kind: "fiyat", value: 900, validFrom: d("2026-07-01") }), req),
    ).toBe(false);
  });
});

describe("özgüllük", () => {
  it("MÜŞTERİ+MALZEME EN ÖZGÜLDÜR", () => {
    const general = cond({ id: "g", kind: "fiyat", value: 900 });
    const itemOnly = cond({ id: "i", kind: "fiyat", value: 880, itemCode: "MM-500" });
    const both = cond({ id: "b", kind: "fiyat", value: 850, itemCode: "MM-500", partnerId: "P-1" });
    expect(specificity(both)).toBeGreaterThan(specificity(itemOnly));
    expect(specificity(itemOnly)).toBeGreaterThan(specificity(general));
  });
});

describe("fiyat hesabı", () => {
  it("EN ÖZGÜL KOŞUL KAZANIR", () => {
    const r = priceFor(
      [
        cond({ id: "g", kind: "fiyat", value: 900 }),
        cond({ id: "i", kind: "fiyat", value: 880, itemCode: "MM-500" }),
        cond({ id: "b", kind: "fiyat", value: 850, itemCode: "MM-500", partnerId: "P-1" }),
      ],
      req,
    );
    expect(r.unitPrice).toBe(850);
    expect(r.appliedConditions[0]!.id).toBe("b");
    expect(r.appliedConditions[0]!.reason).toContain("müşteriye özel");
  });

  it("SIRA GİRDİ SIRASINDAN BAĞIMSIZDIR", () => {
    // Aynı sipariş iki kez hesaplandığında iki farklı fiyat çıkmamalı.
    const conds = [
      cond({ id: "b", kind: "fiyat", value: 850, itemCode: "MM-500", partnerId: "P-1" }),
      cond({ id: "g", kind: "fiyat", value: 900 }),
    ];
    expect(priceFor(conds, req).unitPrice).toBe(850);
    expect(priceFor([...conds].reverse(), req).unitPrice).toBe(850);
  });

  it("İSKONTOLAR TOPLANIR — fiyat koşulu tektir", () => {
    // Kampanya iskontosu ile müşteri iskontosu birlikte geçerlidir.
    const r = priceFor(
      [
        cond({ id: "p", kind: "fiyat", value: 900 }),
        cond({ id: "d1", kind: "iskonto_yuzde", value: 5, partnerId: "P-1" }),
        cond({ id: "d2", kind: "iskonto_yuzde", value: 3, itemCode: "MM-500" }),
      ],
      req,
    );
    expect(r.unitPrice).toBe(900);
    expect(r.discountPercent).toBe(8);
  });

  it("miktar kademesi devreye girer", () => {
    const conds = [
      cond({ id: "p", kind: "fiyat", value: 900, itemCode: "MM-500" }),
      cond({ id: "q", kind: "fiyat", value: 820, itemCode: "MM-500", minQuantity: 50 }),
    ];
    expect(priceFor(conds, req).unitPrice).toBe(900);
    expect(priceFor(conds, { ...req, quantity: 60 }).unitPrice).toBe(820);
  });

  it("FİYAT BULUNAMAZSA UYDURULMAZ", () => {
    // Sıfır fiyat "bedava" demektir ve faturayı sıfır tutarlı yapar.
    const r = priceFor([cond({ id: "d", kind: "iskonto_yuzde", value: 5 })], req);
    expect(r.unitPrice).toBe(null);
    expect(r.caveat).toContain("UYDURULMAZ");
  });

  it("TOPLAM İSKONTO %100'E ULAŞAMAZ", () => {
    // Ulaşsaydı negatif fiyat doğar ve fatura müşteriye para öderdi.
    expect(() =>
      priceFor(
        [
          cond({ id: "p", kind: "fiyat", value: 900 }),
          cond({ id: "d1", kind: "iskonto_yuzde", value: 60 }),
          cond({ id: "d2", kind: "iskonto_yuzde", value: 45 }),
        ],
        req,
      ),
    ).toThrow(PricingConditionError);
  });

  it("ek ücret ayrı taşınır", () => {
    const r = priceFor(
      [
        cond({ id: "p", kind: "fiyat", value: 900 }),
        cond({ id: "s", kind: "ek_ucret", value: 50 }),
      ],
      req,
    );
    expect(r.surcharge).toBe(50);
  });

  it("FİYATIN NEREDEN GELDİĞİ AÇIKLANIR", () => {
    // "Bu fiyat nereden çıktı" sorusunun cevabı olmalı.
    const r = priceFor(
      [cond({ id: "b", kind: "fiyat", value: 850, itemCode: "MM-500", partnerId: "P-1", minQuantity: 5 })],
      req,
    );
    expect(r.appliedConditions[0]!.reason).toContain("müşteriye özel");
    expect(r.appliedConditions[0]!.reason).toContain("malzemeye özel");
    expect(r.appliedConditions[0]!.reason).toContain("5+ miktar");
  });
});
