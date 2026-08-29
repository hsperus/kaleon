/**
 * İçe aktarma çerçevesi ve nesneleri.
 *
 * İçe aktarmada en pahalı hata SESSİZ BOZULMADIR: dosya "başarıyla
 * aktarıldı" der, veriler yanlıştır ve aylar sonra bir mutabakat tutmadığında
 * ortaya çıkar. Buradaki testlerin çoğu o sessizliği kırar.
 */

import { describe, expect, it } from "vitest";
import { parseCsv } from "../src/modules/import/csv.js";
import { detectObject, mapColumns, matchScore } from "../src/modules/import/framework.js";
import {
  ATTENDANCE_OBJECT,
  BANK_OBJECT,
  EMPLOYEE_OBJECT,
  IMPORT_OBJECTS,
  PARTNER_OBJECT,
  SALES_ORDER_OBJECT,
  findObject,
  parseWith,
} from "../src/modules/import/objects.js";
import { createPrincipal, holds } from "../src/kernel/rbac.js";

// Türkçe Excel çıktıları: BOM, noktalı virgül, Türkçe başlıklar.
const PARTNERS = `﻿Cari Kodu;Unvan;Vergi No;Tür
C-001;Burçelik Bursa Çelik Döküm Sanayi A.Ş.;1234567890;Tedarikçi
C-002;Gürateş Metal Sanayi Ltd. Şti.;1000000018;Tedarikçi
C-003;Volvo Group Sweden AB;;Müşteri`;

const BANK = `﻿Banka;Hesap No;IBAN;Para Birimi;Tarih;Kullanılabilir;Blokeli
Garanti BBVA;ACC-1;TR11;TL;16.05.2026;12.400.000,00;0
İş Bankası;ACC-2;TR22;EUR;16.05.2026;126.050,55;16.650,00`;

const ATTENDANCE = `﻿Personel Kodu;Tarih;Çalışılan;Planlanan;Hafta Sonu;Onay
E-1042;04.05.2026;10:00;8:00;Hayır;Evet
E-1042;09.05.2026;8:00;;Evet;Hayır`;

const EMPLOYEES = `﻿Personel Kodu;Ad Soyad;Departman;Görev;İşe Giriş;Brüt Ücret
E-1042;Hasan Turan;Kaynak;Operatör;01.03.2020;62.000,00
E-1180;Ayşe Demir;Montaj;Operatör;15.09.2021;58.000,00`;

const SALES = `﻿Sipariş No;Müşteri;Termin;Günlük Ceza;Ceza Tavanı;Para Birimi
SO-2026-0418;Volvo Group Sweden AB;12.05.2026;19.500,00;200.000,00;TL
SO-2026-0427;Volvo;13.05.2026;;;TL`;

describe("sütun eşleme", () => {
  it("Türkçe başlıkları tanır", () => {
    const c = mapColumns(["Cari Kodu", "Unvan", "Vergi No", "Tür"], PARTNER_OBJECT.fields);
    expect(c).toMatchObject({ code: "Cari Kodu", legalName: "Unvan", taxId: "Vergi No", type: "Tür" });
  });

  it("büyük harf ve Türkçe karakter farkı engel değil", () => {
    const c = mapColumns(["CARİ KODU", "UNVANI", "VKN"], PARTNER_OBJECT.fields);
    expect(c.code).toBe("CARİ KODU");
    expect(c.legalName).toBe("UNVANI");
    expect(c.taxId).toBe("VKN");
  });

  it("BULUNAMAYAN SÜTUN null KALIR — sessizce atlanmaz", () => {
    const c = mapColumns(["Unvan"], PARTNER_OBJECT.fields);
    expect(c.taxId).toBe(null);
    expect(c.code).toBe(null);
  });

  it("BİR BAŞLIK İKİ ALANA ATANMAZ", () => {
    // "Kod" hem cari kodu hem entegratör kodu takma adına uyabilir; ikisine
    // birden atanırsa aynı sütun iki farklı alan olarak okunur.
    const c = mapColumns(["Kod", "Unvan"], PARTNER_OBJECT.fields);
    const used = Object.values(c).filter(Boolean);
    expect(new Set(used).size).toBe(used.length);
  });
});

describe("dosya türü tanıma", () => {
  const all = IMPORT_OBJECTS;

  it("cari dosyasını tanır", () => {
    const d = detectObject(parseCsv(PARTNERS).headers, all);
    expect(d[0]?.object.id).toBe("partners");
  });

  it("banka dosyasını tanır", () => {
    const d = detectObject(parseCsv(BANK).headers, all);
    expect(d[0]?.object.id).toBe("bank");
  });

  it("puantaj dosyasını tanır", () => {
    const d = detectObject(parseCsv(ATTENDANCE).headers, all);
    expect(d[0]?.object.id).toBe("attendance");
  });

  it("personel dosyasını tanır", () => {
    const d = detectObject(parseCsv(EMPLOYEES).headers, all);
    expect(d[0]?.object.id).toBe("employees");
  });

  it("sipariş dosyasını tanır", () => {
    const d = detectObject(parseCsv(SALES).headers, all);
    expect(d[0]?.object.id).toBe("sales_orders");
  });

  it("ZORUNLU ALANI EKSİK NESNE HİÇ ÖNERİLMEZ", () => {
    // Banka nesnesi hesap no ve para birimi olmadan seçilemez.
    expect(matchScore(["Banka", "Tutar"], BANK_OBJECT)).toBe(0);
  });

  it("tanınmayan dosya boş döner — tahmin edilmez", () => {
    expect(detectObject(["Renk", "Beden", "Adet"], all)).toEqual([]);
  });

  it("YALNIZCA YETKİLİ OLUNAN NESNELER ARASINDAN SEÇİLİR", () => {
    // İK müdürüne cari dosyası verilse bile cari nesnesi aday olmamalı.
    const ik = createPrincipal({ userId: "u", tenantId: "t", roles: ["ik_muduru"] });
    const allowed = IMPORT_OBJECTS.filter((o) => holds(ik, o.requires));
    expect(allowed.map((o) => o.id).sort()).toEqual(["attendance", "employees"]);
    expect(detectObject(parseCsv(PARTNERS).headers, allowed)).toEqual([]);
  });
});

describe("yetki dağılımı", () => {
  const principal = (role: string) =>
    createPrincipal({ userId: "u", tenantId: "t", roles: [role as never] });
  const allowedIds = (role: string) =>
    IMPORT_OBJECTS.filter((o) => holds(principal(role), o.requires))
      .map((o) => o.id)
      .sort();

  it("patron her şeyi yükleyebilir", () => {
    expect(allowedIds("patron")).toHaveLength(IMPORT_OBJECTS.length);
  });

  it("CFO banka ve siparişi yükler, puantajı YÜKLEYEMEZ", () => {
    expect(allowedIds("cfo")).toEqual(["bank", "sales_orders"]);
  });

  it("İK personel ve puantajı yükler, bankayı YÜKLEYEMEZ", () => {
    expect(allowedIds("ik_muduru")).toEqual(["attendance", "employees"]);
  });

  it("satın alma yalnızca cariyi yükler", () => {
    expect(allowedIds("satin_alma")).toEqual(["partners"]);
  });

  it("OPERATÖR HİÇBİR ŞEY YÜKLEYEMEZ", () => {
    expect(allowedIds("operator")).toEqual([]);
  });

  it("depo sorumlusu hiçbir şey yükleyemez", () => {
    expect(allowedIds("depo_sorumlusu")).toEqual([]);
  });
});

describe("cari ayrıştırma", () => {
  it("geçerli satırlar okunur", () => {
    const r = parseWith(PARTNER_OBJECT, parseCsv(PARTNERS));
    expect(r.errors).toEqual([]);
    expect(r.valid).toHaveLength(3);
    expect(r.valid[0]).toMatchObject({ code: "C-001", taxId: { kind: "vkn", value: "1234567890" } });
    expect(r.valid[2]).toMatchObject({ isCustomer: true, isSupplier: false });
  });

  it("GEÇERSİZ VKN SESSİZCE KAYDEDİLMEZ", () => {
    const r = parseWith(PARTNER_OBJECT, parseCsv("Unvan;Vergi No\nHatalı A.Ş.;9999999999"));
    expect(r.valid).toEqual([]);
    expect(r.errors[0]).toMatchObject({ line: 2, field: "vergi no" });
  });

  it("HATALI SATIR DİĞERLERİNİ DURDURMAZ", () => {
    const r = parseWith(
      PARTNER_OBJECT,
      parseCsv(`Unvan;Vergi No\nDoğru A.Ş.;1234567890\nHatalı;9999999999\nDiğer;1000000018`),
    );
    expect(r.valid).toHaveLength(2);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]!.line).toBe(3);
  });

  it("ZORUNLU SÜTUN YOKSA DOSYA TÜMDEN REDDEDİLİR", () => {
    const r = parseWith(PARTNER_OBJECT, parseCsv("Kod;Şehir\nC-1;Bursa"));
    expect(r.valid).toEqual([]);
    expect(r.errors[0]!.message).toContain("Zorunlu sütun bulunamadı");
    expect(r.errors[0]!.message).toContain("Unvan");
  });
});

describe("banka ayrıştırma", () => {
  it("Türkçe tutar ve para birimi okunur", () => {
    const r = parseWith(BANK_OBJECT, parseCsv(BANK));
    expect(r.errors).toEqual([]);
    expect(r.valid[0]).toMatchObject({ currency: "TRY", available: 12_400_000, blocked: 0 });
    expect(r.valid[1]).toMatchObject({ currency: "EUR", available: 126_050.55, blocked: 16_650 });
  });

  it("PARA BİRİMİ VARSAYILMAZ", () => {
    // "TRY kabul edelim" demek, EUR hesabını TL sanıp toplam pozisyonu
    // milyonlarca lira yanlış göstermektir.
    const r = parseWith(
      BANK_OBJECT,
      parseCsv("Banka;Hesap No;Para Birimi;Tarih;Kullanılabilir\nX;A1;ABC123;16.05.2026;100"),
    );
    expect(r.valid).toEqual([]);
    expect(r.errors[0]!.message).toContain("para birimi tanınmadı");
  });

  it("₺ ve Euro gibi yazımlar tanınır", () => {
    for (const [raw, code] of [["₺", "TRY"], ["Euro", "EUR"], ["Dolar", "USD"], ["TL", "TRY"]]) {
      const r = parseWith(
        BANK_OBJECT,
        parseCsv(`Banka;Hesap No;Para Birimi;Tarih;Kullanılabilir\nX;A1;${raw};16.05.2026;100`),
      );
      expect(r.valid[0]?.currency, raw).toBe(code);
    }
  });

  it("aynı hesap ve tarih dosyada tekrar edemez", () => {
    const r = parseWith(
      BANK_OBJECT,
      parseCsv(
        `Banka;Hesap No;Para Birimi;Tarih;Kullanılabilir\nX;A1;TL;16.05.2026;100\nX;A1;TL;16.05.2026;200`,
      ),
    );
    expect(r.valid).toHaveLength(1);
    expect(r.errors[0]!.message).toContain("tekrar ediyor");
  });

  it("blokeli sütunu yoksa sıfır kabul edilir", () => {
    const r = parseWith(
      BANK_OBJECT,
      parseCsv("Banka;Hesap No;Para Birimi;Tarih;Kullanılabilir\nX;A1;TL;16.05.2026;100"),
    );
    expect(r.valid[0]!.blocked).toBe(0);
  });
});

describe("puantaj ayrıştırma", () => {
  it("saat:dakika ve ondalık biçimler okunur", () => {
    const r = parseWith(ATTENDANCE_OBJECT, parseCsv(ATTENDANCE));
    expect(r.errors).toEqual([]);
    expect(r.valid[0]).toMatchObject({ workedMinutes: 600, plannedMinutes: 480, approved: true });
  });

  it("HAFTA SONUNDA PLANLANAN SÜRE SIFIRDIR", () => {
    // Sürenin tamamı fazla mesaidir; planlanan 480 yazılsa bile.
    const r = parseWith(ATTENDANCE_OBJECT, parseCsv(ATTENDANCE));
    expect(r.valid[1]).toMatchObject({ isWeekend: true, plannedMinutes: 0, workedMinutes: 480 });
  });

  it("BİR GÜNDE 24 SAATTEN FAZLA SÜRE REDDEDİLİR", () => {
    // Sessizce kabul edilirse bordroda karşılığı olmayan mesai doğar.
    const r = parseWith(
      ATTENDANCE_OBJECT,
      parseCsv("Personel Kodu;Tarih;Çalışılan\nE-1;04.05.2026;1500"),
    );
    expect(r.valid).toEqual([]);
    expect(r.errors[0]!.message).toContain("24 saatten fazla");
  });

  it("planlanan sütunu yoksa 8 saat varsayılır", () => {
    const r = parseWith(
      ATTENDANCE_OBJECT,
      parseCsv("Personel Kodu;Tarih;Çalışılan\nE-1;04.05.2026;10:00"),
    );
    expect(r.valid[0]!.plannedMinutes).toBe(480);
  });

  it("aynı personelin aynı günü tekrar edemez", () => {
    const r = parseWith(
      ATTENDANCE_OBJECT,
      parseCsv("Personel Kodu;Tarih;Çalışılan\nE-1;04.05.2026;8\nE-1;04.05.2026;9"),
    );
    expect(r.valid).toHaveLength(1);
    expect(r.errors[0]!.message).toContain("tekrar ediyor");
  });
});

describe("personel ayrıştırma", () => {
  it("temel alanlar okunur", () => {
    const r = parseWith(EMPLOYEE_OBJECT, parseCsv(EMPLOYEES));
    expect(r.errors).toEqual([]);
    expect(r.valid[0]).toMatchObject({
      code: "E-1042",
      fullName: "Hasan Turan",
      department: "Kaynak",
      grossSalary: 62_000,
    });
  });

  it("maaş sütunu yoksa null kalır — sıfır yazılmaz", () => {
    const r = parseWith(EMPLOYEE_OBJECT, parseCsv("Personel Kodu;Ad Soyad\nE-1;Ali Veli"));
    expect(r.valid[0]!.grossSalary).toBe(null);
  });
});

describe("sipariş ayrıştırma", () => {
  it("termin ve ceza okunur", () => {
    const r = parseWith(SALES_ORDER_OBJECT, parseCsv(SALES));
    expect(r.errors).toEqual([]);
    expect(r.valid[0]).toMatchObject({
      orderNo: "SO-2026-0418",
      committedDate: "2026-05-12",
      penaltyPerDay: 19_500,
      penaltyCap: 200_000,
    });
  });

  it("CEZA BOŞSA null KALIR — sıfıra çevrilmez", () => {
    // "sözleşmede yazmıyor" ile "ceza yok" farklı cevaplar üretir.
    const r = parseWith(SALES_ORDER_OBJECT, parseCsv(SALES));
    expect(r.valid[1]!.penaltyPerDay).toBe(null);
    expect(r.valid[1]!.penaltyCap).toBe(null);
  });

  it("geçersiz termin reddedilir", () => {
    const r = parseWith(
      SALES_ORDER_OBJECT,
      parseCsv("Sipariş No;Müşteri;Termin\nSO-1;Volvo;31.02.2026"),
    );
    expect(r.valid).toEqual([]);
    expect(r.errors[0]!.field).toBe("termin");
  });
});

describe("nesne kaydı", () => {
  it("kimlikle bulunur", () => {
    expect(findObject("bank")?.label).toBe("Banka bakiyeleri");
    expect(findObject("yok")).toBeUndefined();
  });

  it("her nesnenin şablon başlıkları ve zorunlu alanı var", () => {
    for (const o of IMPORT_OBJECTS) {
      expect(o.templateHeaders.length, o.id).toBeGreaterThan(1);
      expect(o.fields.some((f) => f.required), o.id).toBe(true);
      expect(o.requires, o.id).toContain(":");
    }
  });
});
