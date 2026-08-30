/**
 * Malzeme kartı ve ölçü birimi çevrimi.
 *
 * Bu dosyadaki testlerin çoğu SESSİZ MİKTAR HATASINI önler. Sipariş "koli",
 * stok "adet", üretim "kg" ile çalışır; çevrim olmadan 10 koli ile 240 adet
 * toplanır ve 250 çıkar. Kimse envanter sayımına kadar fark etmez.
 */

import { describe, expect, it } from "vitest";
import {
  ITEM_TYPES,
  ItemValidationError,
  UnitConversionError,
  fromBaseQuantity,
  grossRequirement,
  isStocked,
  toBaseQuantity,
  validateItem,
  validateUnit,
} from "../src/modules/master-data/item.js";

const KOLI = [{ uom: "koli", factor: 24 }, { uom: "palet", factor: 1200 }];

describe("ölçü birimi çevrimi", () => {
  it("temel birim olduğu gibi kalır", () => {
    expect(toBaseQuantity(240, "adet", "adet", KOLI)).toBe(240);
  });

  it("alternatif birim temel birime çevrilir", () => {
    expect(toBaseQuantity(10, "koli", "adet", KOLI)).toBe(240);
    expect(toBaseQuantity(2, "palet", "adet", KOLI)).toBe(2400);
  });

  it("BİLİNMEYEN BİRİM SESSİZCE KABUL EDİLMEZ", () => {
    // "Belki temel birimdir" varsayımı 10 koliyi 10 adet kaydeder ve stok
    // 230 adet eksik kalır.
    expect(() => toBaseQuantity(10, "kutu", "adet", KOLI)).toThrow(UnitConversionError);
    expect(() => toBaseQuantity(10, "kutu", "adet", KOLI)).toThrow(/tanımlı değil/);
  });

  it("hata mesajı tanımlı birimleri söyler", () => {
    try {
      toBaseQuantity(1, "kutu", "adet", KOLI);
    } catch (e) {
      expect((e as Error).message).toContain("koli");
      expect((e as Error).message).toContain("palet");
    }
  });

  it("bozuk katsayı reddedilir", () => {
    expect(() => toBaseQuantity(1, "x", "adet", [{ uom: "x", factor: 0 }])).toThrow(
      UnitConversionError,
    );
    expect(() => toBaseQuantity(1, "x", "adet", [{ uom: "x", factor: -3 }])).toThrow(
      UnitConversionError,
    );
  });

  it("gösterim için geri çevrilir", () => {
    expect(fromBaseQuantity(240, "koli", "adet", KOLI)).toBe(10);
  });

  it("ÇEVRİM GİDİŞ-DÖNÜŞ KAYIPSIZ", () => {
    const units = [{ uom: "lb", factor: 0.45359237 }];
    const base = toBaseQuantity(100, "lb", "kg", units);
    expect(fromBaseQuantity(base, "lb", "kg", units)).toBeCloseTo(100, 9);
  });

  it("TEMEL BİRİM ALTERNATİF OLARAK TANIMLANAMAZ", () => {
    // "1 adet = 2 adet" gibi bir kayıt çevrimi bozar.
    expect(() => validateUnit({ uom: "adet", factor: 2 }, "adet")).toThrow(/alternatif birim/);
  });

  it("sıfır katsayılı birim tanımlanamaz", () => {
    expect(() => validateUnit({ uom: "koli", factor: 0 }, "adet")).toThrow(/sıfırdan büyük/);
  });
});

describe("malzeme doğrulaması", () => {
  const base = { code: "FR-22", name: "Şasi Profili", type: "mamul", baseUom: "adet" };

  it("geçerli malzeme normalize edilir", () => {
    const item = validateItem(base);
    expect(item.normalized).toContain("sasi");
    expect(item.valuationMethod).toBe("hareketli_ortalama");
    expect(item.procurementType).toBe("satin_alma");
  });

  it("boş kod ve ad reddedilir", () => {
    expect(() => validateItem({ ...base, code: "  " })).toThrow(/kodu boş/);
    expect(() => validateItem({ ...base, name: "" })).toThrow(/adı boş/);
  });

  it("geçersiz tür reddedilir ve geçerliler söylenir", () => {
    try {
      validateItem({ ...base, type: "seyler" });
      throw new Error("olmamalı");
    } catch (e) {
      expect(e).toBeInstanceOf(ItemValidationError);
      expect((e as Error).message).toContain("hammadde");
    }
  });

  it("HİZMET STOKLANMAZ — parti takibi işaretlenemez", () => {
    expect(() =>
      validateItem({ ...base, type: "hizmet", batchManaged: true }),
    ).toThrow(/stoklanmaz/);
    expect(isStocked("hizmet")).toBe(false);
    expect(isStocked("mamul")).toBe(true);
  });

  it("RAF ÖMRÜ PARTİ TAKİBİ GEREKTİRİR", () => {
    // Parti yoksa son kullanma tarihi hangi mala ait bilinemez.
    expect(() =>
      validateItem({ ...base, shelfLifeDays: 180, batchManaged: false }),
    ).toThrow(/parti takibi açık olmalı/);
    expect(() =>
      validateItem({ ...base, shelfLifeDays: 180, batchManaged: true }),
    ).not.toThrow();
  });

  it("PARTİ VE SERİ AYNI ANDA OLMAZ", () => {
    // Parti bir yığını, seri tek bir nesneyi tanımlar.
    expect(() =>
      validateItem({ ...base, batchManaged: true, serialManaged: true }),
    ).toThrow(/aynı anda açılamaz/);
  });

  it("negatif tedarik süresi reddedilir", () => {
    expect(() => validateItem({ ...base, leadTimeDays: -1 })).toThrow(/negatif/);
  });

  it("bütün türler stoklanır mı bilinir", () => {
    for (const t of ITEM_TYPES) {
      expect(typeof isStocked(t)).toBe("boolean");
    }
  });
});

describe("BOM brüt ihtiyaç", () => {
  it("firesiz ihtiyaç düz çarpım", () => {
    expect(grossRequirement(2, 100, 0)).toBe(200);
  });

  it("FİRE HESABA KATILIR", () => {
    // 100 adet üretmek için %2 fireli bileşenden 102 gerekir; katmamak
    // üretimin ortasında malzeme bitmesi demektir.
    expect(grossRequirement(1, 100, 2)).toBeCloseTo(102, 6);
    expect(grossRequirement(2.5, 40, 5)).toBeCloseTo(105, 6);
  });
});
