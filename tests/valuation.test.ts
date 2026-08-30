/**
 * Stok değerleme ve döviz kuru.
 *
 * Ortak dert: SIFIRIN "BİLİNMİYOR" YERİNE GEÇMESİ. Maliyeti bilinmeyen bir
 * mal sıfır maliyetle değerlenirse %100 kâr görünür; kuru bulunamayan bir
 * tutar 1'le çarpılırsa 126.000 EUR, 126.000 TL olur. İkisi de sessizdir
 * ve ikisi de raporun tamamını çöpe atar.
 */

import { describe, expect, it } from "vitest";
import {
  MAX_RATE_AGE_DAYS,
  ExchangeRateError,
  pickRate,
  toBaseCurrency,
} from "../src/modules/finance/exchange.js";
import {
  applyIssue,
  applyReceipt,
  purchasePriceVariance,
  valueOnHand,
  ValuationError,
} from "../src/modules/inventory/valuation.js";

const q = (date: string, rate: number) => ({
  rate,
  quotedAt: new Date(date),
  source: "TCMB",
});

describe("döviz kuru seçimi", () => {
  const quotes = [q("2026-06-12", 36.1), q("2026-06-15", 36.4), q("2026-06-16", 36.55)];

  it("işlem tarihindeki kuru seçer", () => {
    expect(pickRate(quotes, "EUR", new Date("2026-06-15")).rate).toBe(36.4);
  });

  it("İLERİ TARİHLİ KUR KULLANILMAZ", () => {
    // 16'sının kuru, 15'indeki bir faturanın karşılığı değildir.
    const r = pickRate(quotes, "EUR", new Date("2026-06-15"));
    expect(r.quotedAt).toBe("2026-06-15");
    expect(r.rate).not.toBe(36.55);
  });

  it("HAFTA SONU İÇİN SON İLAN EDİLEN KUR KULLANILIR", () => {
    // 13-14 Haziran hafta sonu; 12'sinin kuru geçerlidir.
    const r = pickRate(quotes, "EUR", new Date("2026-06-14"));
    expect(r.rate).toBe(36.1);
    expect(r.ageDays).toBe(2);
  });

  it("ÇOK ESKİ KUR SESSİZCE KULLANILMAZ", () => {
    expect(() => pickRate([q("2026-05-01", 35)], "EUR", new Date("2026-06-15"))).toThrow(
      new RegExp(`${MAX_RATE_AGE_DAYS} günden eski`),
    );
  });

  it("KUR YOKSA HESAP YAPILMAZ — 1 VARSAYILMAZ", () => {
    expect(() => pickRate([], "EUR", new Date("2026-06-15"))).toThrow(ExchangeRateError);
    expect(() => pickRate([], "EUR", new Date("2026-06-15"))).toThrow(/Kur bilinmeden/);
  });

  it("TL için kur 1'dir ve tablo gerekmez", () => {
    expect(pickRate([], "TRY", new Date("2026-06-15")).rate).toBe(1);
  });

  it("sıfır veya negatif kur reddedilir", () => {
    expect(() => pickRate([q("2026-06-15", 0)], "EUR", new Date("2026-06-15"))).toThrow(
      ExchangeRateError,
    );
  });

  it("çevrim hangi kurla yapıldığını DÖNDÜRÜR", () => {
    const r = pickRate(quotes, "EUR", new Date("2026-06-16"));
    const c = toBaseCurrency(126_050.55, r);
    expect(c.amount).toBe(4_607_147.6);
    expect(c.rate).toBe(36.55);
    expect(c.quotedAt).toBe("2026-06-16");
  });
});

describe("hareketli ortalama", () => {
  it("ilk giriş ortalamayı belirler", () => {
    const r = applyReceipt({ quantityOnHand: 0, unitCost: null }, { quantity: 100, unitCost: 50 });
    expect(r).toEqual({ quantityOnHand: 100, unitCost: 50, valueIn: 5000, caveat: null });
  });

  it("sonraki giriş ağırlıklı ortalama alır", () => {
    const r = applyReceipt({ quantityOnHand: 100, unitCost: 50 }, { quantity: 100, unitCost: 70 });
    expect(r.unitCost).toBe(60);
    expect(r.quantityOnHand).toBe(200);
  });

  it("miktar ağırlıklıdır — basit ortalama DEĞİL", () => {
    // Basit ortalama 60 verirdi; doğrusu 900 birimin ağırlığıdır.
    const r = applyReceipt({ quantityOnHand: 900, unitCost: 50 }, { quantity: 100, unitCost: 70 });
    expect(r.unitCost).toBe(52);
  });

  it("ÖNCEKİ MALİYET BİLİNMİYORSA ORTALAMA UYDURULMAZ — giriş yine kaydedilir", () => {
    // Fiziksel olay reddedilmez; ama ortalama alınamadığı SÖYLENİR.
    const r = applyReceipt({ quantityOnHand: 100, unitCost: null }, { quantity: 50, unitCost: 70 });
    expect(r.unitCost).toBe(70);
    expect(r.quantityOnHand).toBe(150);
    expect(r.caveat).toContain("açılış maliyeti");
  });

  it("EKSİ STOKTA ORTALAMA HESAPLANMAZ — giriş yine kaydedilir", () => {
    const r = applyReceipt({ quantityOnHand: -10, unitCost: 50 }, { quantity: 50, unitCost: 70 });
    expect(r.unitCost).toBe(70);
    expect(r.quantityOnHand).toBe(40);
    expect(r.caveat).toContain("Sayım");
  });

  it("temiz girişte uyarı YOKTUR — her kayda uyarı asmak uyarıyı öldürür", () => {
    const r = applyReceipt({ quantityOnHand: 100, unitCost: 50 }, { quantity: 100, unitCost: 70 });
    expect(r.caveat).toBe(null);
  });

  it("sıfır maliyetli giriş kabul edilir — bedelsiz numune", () => {
    const r = applyReceipt({ quantityOnHand: 100, unitCost: 50 }, { quantity: 100, unitCost: 0 });
    expect(r.unitCost).toBe(25);
    expect(r.caveat).toBe(null);
  });
});

describe("çıkış değerlemesi", () => {
  it("çıkış ORTALAMAYI DEĞİŞTİRMEZ", () => {
    const r = applyIssue({ quantityOnHand: 200, unitCost: 60 }, 50);
    expect(r.unitCost).toBe(60);
    expect(r.valueOut).toBe(3000);
    expect(r.quantityOnHand).toBe(150);
  });

  it("MALİYET BİLİNMİYORSA ÇIKIŞ DEĞERİ null — SIFIR DEĞİL", () => {
    const r = applyIssue({ quantityOnHand: 200, unitCost: null }, 50);
    expect(r.valueOut).toBe(null);
  });
});

describe("standart maliyet farkı", () => {
  it("fark stok değerine değil fark hesabına yazılır", () => {
    const v = purchasePriceVariance(100, 100, 112);
    expect(v.standardValue).toBe(10_000);
    expect(v.actualValue).toBe(11_200);
    expect(v.variance).toBe(1_200);
  });

  it("ucuza alım negatif fark üretir", () => {
    expect(purchasePriceVariance(10, 100, 90).variance).toBe(-100);
  });
});

describe("eldeki stok değeri", () => {
  it("bilinen maliyet çarpılır", () => {
    expect(valueOnHand(150, 60)).toMatchObject({ value: 9000, caveat: null });
  });

  it("MALİYETİ OLMAYAN KALEM SIFIRLA TOPLANMAZ", () => {
    const v = valueOnHand(150, null);
    expect(v.value).toBe(null);
    expect(v.caveat).toContain("DAHİL EDİLMEDİ");
  });

  it("eksi bakiye değeri hesaplanır ama GÜVENİLMEZ diye işaretlenir", () => {
    const v = valueOnHand(-5, 60);
    expect(v.value).toBe(-300);
    expect(v.caveat).toContain("sayım");
  });
});
