/**
 * Kullanıcı tanımlı izlemeler.
 *
 * İZLEME SESSİZ ÇALIŞIR VE KULLANICI ONA GÜVENİR. Yanlış tetiklenen bir
 * izleme gürültü üretir ve bir süre sonra hepsi görmezden gelinir;
 * tetiklenmeyen bir izleme ise izlenmediğini fark ettirmez. İkisi de
 * izlemeyi yok eder — testler bu iki yönü de hedefliyor.
 */

import { describe, expect, it } from "vitest";
import {
  describeWatch,
  evaluateWatch,
  numericPaths,
  readPath,
  renderMessage,
  type WatchDefinition,
} from "../src/modules/briefing/watch.js";

const base: WatchDefinition = {
  id: "w1",
  name: "Kasa alt sınırı",
  tool: "get_bank_balance",
  input: {},
  path: "total",
  operator: "lt",
  threshold: 50_000,
  level: 2,
  message: "Kasa {deger} TL'ye düştü (eşik {esik}).",
  lastValue: null,
};

describe("değer okuma", () => {
  it("düz alanı okur", () => {
    expect(readPath({ total: 1200 }, "total")).toBe(1200);
  });

  it("iç içe alanı okur", () => {
    expect(readPath({ a: { b: { c: 7 } } }, "a.b.c")).toBe(7);
  });

  it("dizi elemanını okur", () => {
    expect(readPath({ rows: [{ amount: 42 }] }, "rows[0].amount")).toBe(42);
  });

  it("DİZİ UZUNLUĞU İZLENEBİLİR", () => {
    // "bekleyen onay sayısı 5'i geçerse" en sık kurulan izlemedir.
    expect(readPath({ items: [1, 2, 3] }, "items.length")).toBe(3);
  });

  it("boolean 1/0 olarak okunur", () => {
    // "bilanço denk mi" gibi alanlar da izlenebilmeli.
    expect(readPath({ balanced: false }, "balanced")).toBe(0);
    expect(readPath({ balanced: true }, "balanced")).toBe(1);
  });

  it("BULUNAMAYAN YOL NULL DÖNER — sıfır değil", () => {
    // Sıfır sayılsaydı "kasa sıfırın altına düştü" gibi sahte alarmlar
    // üretirdi.
    expect(readPath({ total: 100 }, "yok")).toBeNull();
    expect(readPath({ a: { b: 1 } }, "a.c.d")).toBeNull();
    expect(readPath(null, "total")).toBeNull();
    expect(readPath({ rows: [] }, "rows[3].amount")).toBeNull();
  });

  it("sayısal olmayan değer null döner", () => {
    expect(readPath({ name: "Garanti" }, "name")).toBeNull();
  });
});

describe("değerlendirme", () => {
  it("eşik aşılınca tetiklenir", () => {
    const r = evaluateWatch(base, { total: 40_000 });
    expect(r.fired).toBe(true);
    expect(r.value).toBe(40_000);
  });

  it("eşik aşılmayınca tetiklenmez", () => {
    const r = evaluateWatch(base, { total: 60_000 });
    expect(r.fired).toBe(false);
    expect(r.reason).toContain("Eşik");
  });

  it("OKUNAMAYAN DEĞER SAHTE ALARM ÜRETMEZ", () => {
    const r = evaluateWatch(base, { baska: 1 });
    expect(r.fired).toBe(false);
    expect(r.value).toBeNull();
    // Sessiz kalmaz: kullanıcı izlemesinin çalışmadığını bilmeli.
    expect(r.reason).toContain("bulunamadı");
  });

  it("tüm karşılaştırmalar doğru çalışır", () => {
    const cases: [WatchDefinition["operator"], number, number, boolean][] = [
      ["gt", 10, 5, true],
      ["gt", 5, 10, false],
      ["gte", 10, 10, true],
      ["lt", 5, 10, true],
      ["lte", 10, 10, true],
      ["eq", 7, 7, true],
      ["neq", 7, 8, true],
    ];
    for (const [op, value, threshold, expected] of cases) {
      const r = evaluateWatch({ ...base, operator: op, threshold }, { total: value });
      expect(r.fired, `${op} ${value} ${threshold}`).toBe(expected);
    }
  });

  it("eşiksiz izleme çalışmaz", () => {
    const r = evaluateWatch({ ...base, threshold: null }, { total: 1 });
    expect(r.fired).toBe(false);
    expect(r.reason).toContain("Eşik tanımlı değil");
  });
});

describe("değişim izleme", () => {
  const changed: WatchDefinition = { ...base, operator: "changed", threshold: null };

  it("İLK ÖLÇÜMDE DEĞİŞTİ DENMEZ", () => {
    // Karşılaştırılacak önceki değer yok; "değişti" demek yalan olurdu.
    const r = evaluateWatch(changed, { total: 100 });
    expect(r.fired).toBe(false);
    expect(r.reason).toContain("İlk ölçüm");
  });

  it("değer değişince tetiklenir", () => {
    const r = evaluateWatch({ ...changed, lastValue: 100 }, { total: 120 });
    expect(r.fired).toBe(true);
  });

  it("değer aynıysa tetiklenmez", () => {
    const r = evaluateWatch({ ...changed, lastValue: 100 }, { total: 100 });
    expect(r.fired).toBe(false);
  });

  it("SIFIRA DÜŞMEK DE DEĞİŞİMDİR", () => {
    // lastValue kontrolü `null` ile yapılmalı; `!lastValue` yazılsaydı
    // sıfırdan yapılan karşılaştırma "ilk ölçüm" sanılırdı.
    const r = evaluateWatch({ ...changed, lastValue: 0 }, { total: 5 });
    expect(r.fired).toBe(true);
  });
});

describe("mesaj şablonu", () => {
  it("değer ve eşik yerine konur", () => {
    expect(renderMessage("Kasa {deger} TL (eşik {esik}).", 40_000, 50_000)).toBe(
      "Kasa 40.000 TL (eşik 50.000).",
    );
  });

  it("BİLİNMEYEN DEĞER 'bilinmiyor' YAZAR — sıfır değil", () => {
    expect(renderMessage("Değer {deger}.", null, null)).toBe("Değer bilinmiyor.");
  });
});

describe("tanım metni", () => {
  it("eşikli izleme okunur biçimde anlatılır", () => {
    expect(describeWatch(base)).toContain("50.000");
    expect(describeWatch(base)).toContain("küçükse");
  });

  it("değişim izlemesi ayrı anlatılır", () => {
    expect(describeWatch({ ...base, operator: "changed" })).toContain("değişirse");
  });
});

describe("izlenebilir alanları çıkarma", () => {
  it("sayısal alanların yollarını verir", () => {
    const paths = numericPaths({ total: 1, name: "x", nested: { count: 2 } });
    expect(paths).toContain("total");
    expect(paths).toContain("nested.count");
    // Metin alanı izlenemez.
    expect(paths).not.toContain("name");
  });

  it("DİZİDE UZUNLUK VE İLK ELEMAN VERİLİR", () => {
    // 200 satırlık bir sonuçta 200 yol üretmek listeyi kullanılamaz kılardı.
    const paths = numericPaths({ rows: [{ amount: 5 }, { amount: 9 }] });
    expect(paths).toContain("rows.length");
    expect(paths).toContain("rows[0].amount");
    expect(paths).not.toContain("rows[1].amount");
  });

  it("kök dizi de okunur", () => {
    expect(numericPaths([{ a: 1 }])).toContain("length");
    expect(numericPaths([{ a: 1 }])).toContain("[0].a");
  });

  it("boolean alan izlenebilir", () => {
    // "bilanço denk mi" gibi alanlar 1/0 okunur.
    expect(numericPaths({ balanced: true })).toContain("balanced");
  });

  it("DERİNLİK SINIRLI — sonsuz iç içe yapıda donmaz", () => {
    const deep = { a: { b: { c: { d: { e: 1 } } } } };
    expect(numericPaths(deep)).not.toContain("a.b.c.d.e");
  });

  it("boş sonuçta yol yok", () => {
    expect(numericPaths(null)).toEqual([]);
    expect(numericPaths({})).toEqual([]);
  });
});
