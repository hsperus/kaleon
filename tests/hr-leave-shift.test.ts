/**
 * Yıllık izin ve vardiya kuralları.
 *
 * BU DOSYA KANUN METNİNİ SINAR. Buradaki sayılar şirket politikası değil,
 * 4857 sayılı İş Kanunu'nun asgarileridir; sistem bunların altına inerse
 * çalışanın hakkını eksik gösterir ve İK farkında olmadan kanuna aykırı
 * bir vaatte bulunur.
 */

import { describe, expect, it } from "vitest";
import {
  annualEntitlement,
  assertApprover,
  assertRequestable,
  balance,
  completedYears,
  deductsFromAnnual,
  workingDaysBetween,
  LeaveError,
} from "../src/modules/hr/leave.js";
import {
  requiredBreakMinutes,
  shiftHours,
  validateShift,
  weeklyOvertime,
  ShiftError,
  MAX_NIGHT_HOURS,
} from "../src/modules/hr/shift.js";

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

describe("kıdem hesabı", () => {
  it("yıl dönümü gelmeden yıl sayılmaz", () => {
    expect(completedYears(d("2020-03-15"), d("2026-03-14"))).toBe(5);
    expect(completedYears(d("2020-03-15"), d("2026-03-15"))).toBe(6);
  });
});

describe("yıllık izin hakkı — İş Kanunu md. 53", () => {
  it("BİR YILI DOLDURMADAN HAK DOĞMAZ", () => {
    const e = annualEntitlement({ hiredAt: d("2025-08-01"), on: d("2026-06-15") });
    expect(e.days).toBe(0);
    expect(e.basis).toContain("bir yılı doldurmayan");
  });

  it("1–5 yıl kıdem → 14 gün", () => {
    expect(annualEntitlement({ hiredAt: d("2022-01-01"), on: d("2026-06-15") }).days).toBe(14);
  });

  it("BEŞİNCİ YIL DAHİL 14 GÜNDÜR — sınır hatası olmaz", () => {
    // Tam 5 yıl kıdem hâlâ ilk kademededir; 20 gün vermek fazladan hak yazar.
    expect(annualEntitlement({ hiredAt: d("2021-06-15"), on: d("2026-06-15") }).days).toBe(14);
    expect(annualEntitlement({ hiredAt: d("2020-06-15"), on: d("2026-06-15") }).days).toBe(20);
  });

  it("15 yıl ve üzeri → 26 gün", () => {
    expect(annualEntitlement({ hiredAt: d("2011-06-15"), on: d("2026-06-15") }).days).toBe(26);
  });

  it("50 YAŞ ÜSTÜNE KIDEMDEN BAĞIMSIZ EN AZ 20 GÜN", () => {
    const e = annualEntitlement({
      hiredAt: d("2023-01-01"),
      on: d("2026-06-15"),
      birthDate: d("1970-01-01"),
    });
    expect(e.days).toBe(20);
    expect(e.basis).toContain("md. 53/son");
  });

  it("18 yaş altına da en az 20 gün", () => {
    const e = annualEntitlement({
      hiredAt: d("2024-01-01"),
      on: d("2026-06-15"),
      birthDate: d("2009-01-01"),
    });
    expect(e.days).toBe(20);
  });

  it("YAŞ KADEMESİ ÜST KADEMEYİ DÜŞÜRMEZ", () => {
    // 26 günlük hakkı olan 55 yaşındaki çalışan 20'ye indirilemez.
    const e = annualEntitlement({
      hiredAt: d("2005-01-01"),
      on: d("2026-06-15"),
      birthDate: d("1970-01-01"),
    });
    expect(e.days).toBe(26);
  });

  it("hakkın dayanağı her zaman açıklanır", () => {
    expect(annualEntitlement({ hiredAt: d("2022-01-01"), on: d("2026-06-15") }).basis).toContain(
      "md. 53",
    );
  });
});

describe("izin günü sayımı — md. 56", () => {
  it("PAZAR İZİNDEN DÜŞÜLMEZ", () => {
    // 15–21 Haziran 2026: 21'i pazar.
    expect(workingDaysBetween(d("2026-06-15"), d("2026-06-21"))).toBe(6);
  });

  it("RESMÎ TATİL İZİNDEN DÜŞÜLMEZ", () => {
    expect(workingDaysBetween(d("2026-06-15"), d("2026-06-19"), [d("2026-06-17")])).toBe(4);
  });

  it("cumartesi varsayılan olarak iş günüdür", () => {
    // 20 Haziran 2026 cumartesi.
    expect(workingDaysBetween(d("2026-06-20"), d("2026-06-20"))).toBe(1);
  });

  it("işletme cumartesiyi tatil yapıyorsa bildirebilir", () => {
    expect(workingDaysBetween(d("2026-06-20"), d("2026-06-20"), [], [0, 6])).toBe(0);
  });

  it("ters tarih aralığı reddedilir", () => {
    expect(() => workingDaysBetween(d("2026-06-20"), d("2026-06-15"))).toThrow(LeaveError);
  });
});

describe("izin bakiyesi", () => {
  const entitlement = annualEntitlement({ hiredAt: d("2022-01-01"), on: d("2026-06-15") });

  it("BEKLEYEN TALEP DE DÜŞÜLÜR", () => {
    const b = balance({ entitlement, usedDays: 5, pendingDays: 3 });
    // Düşülmeseydi çalışan hakkından fazlasını talep edebilirdi.
    expect(b.remaining).toBe(6);
  });

  it("devreden gün hakka eklenir", () => {
    expect(balance({ entitlement, usedDays: 0, pendingDays: 0, carriedOver: 4 }).entitled).toBe(18);
  });

  it("MAZERET İZNİ YILLIK İZİNDEN DÜŞÜLMEZ", () => {
    // Düşülseydi çalışan, kanunen hakkı olan izni kendi izninden öderdi.
    expect(deductsFromAnnual("evlilik")).toBe(false);
    expect(deductsFromAnnual("olum")).toBe(false);
    expect(deductsFromAnnual("hastalik")).toBe(false);
    expect(deductsFromAnnual("yillik")).toBe(true);
  });
});

describe("izin talebi", () => {
  const entitlement = annualEntitlement({ hiredAt: d("2022-01-01"), on: d("2026-06-15") });
  const b = balance({ entitlement, usedDays: 10, pendingDays: 0 });

  it("kalan hak yetiyorsa kabul edilir", () => {
    expect(() =>
      assertRequestable({ type: "yillik", days: 4, balance: b, overlapping: [] }),
    ).not.toThrow();
  });

  it("HAKTAN FAZLA İZİN ALINAMAZ VE MESAJ SAYI VERİR", () => {
    try {
      assertRequestable({ type: "yillik", days: 5, balance: b, overlapping: [] });
      throw new Error("beklenmedik");
    } catch (e) {
      const m = (e as Error).message;
      expect(m).toContain("Kalan yıllık izin 4 gün");
      expect(m).toContain("kullanılan 10");
    }
  });

  it("ÇAKIŞAN İZİN REDDEDİLİR", () => {
    expect(() =>
      assertRequestable({
        type: "yillik",
        days: 2,
        balance: b,
        overlapping: [{ from: "2026-06-15", to: "2026-06-18" }],
      }),
    ).toThrow(/zaten bir izin var/);
  });

  it("HAK DOĞMAMIŞSA SEBEBİ SÖYLENİR", () => {
    const yeni = balance({
      entitlement: annualEntitlement({ hiredAt: d("2025-08-01"), on: d("2026-06-15") }),
      usedDays: 0,
      pendingDays: 0,
    });
    expect(() =>
      assertRequestable({ type: "yillik", days: 1, balance: yeni, overlapping: [] }),
    ).toThrow(/bir yılı doldurmayan/);
  });

  it("MAZERET İZNİ BAKİYEDEN BAĞIMSIZ ALINIR", () => {
    const bitmis = balance({ entitlement, usedDays: 14, pendingDays: 0 });
    expect(() =>
      assertRequestable({ type: "olum", days: 3, balance: bitmis, overlapping: [] }),
    ).not.toThrow();
  });

  it("sıfır iş günü olan aralık reddedilir", () => {
    expect(() =>
      assertRequestable({ type: "yillik", days: 0, balance: b, overlapping: [] }),
    ).toThrow(/en az bir iş günü/);
  });

  it("KENDİ İZNİNİ ONAYLAYAMAZ", () => {
    expect(() => assertApprover("u-1", "u-1")).toThrow(/Kendi izin talebinizi/);
    expect(() => assertApprover("u-1", "u-2")).not.toThrow();
  });
});

describe("vardiya", () => {
  const gunduz = {
    code: "V1",
    name: "Gündüz",
    startsAt: "08:00",
    endsAt: "17:00",
    breakMinutes: 60,
    isNight: false,
  };

  it("net süre ara dinlenme düşülerek hesaplanır", () => {
    expect(shiftHours(gunduz)).toBe(8);
  });

  it("GÜN AŞAN VARDİYA DOĞRU HESAPLANIR", () => {
    // Basit çıkarma yapılsaydı eksi süre çıkardı.
    expect(
      shiftHours({ ...gunduz, code: "V3", startsAt: "22:00", endsAt: "06:00", breakMinutes: 30 }),
    ).toBe(7.5);
  });

  it("GECE ÇALIŞMASI 7,5 SAATİ AŞAMAZ — md. 69", () => {
    expect(() =>
      validateShift({
        code: "V3",
        name: "Gece",
        startsAt: "22:00",
        endsAt: "07:00",
        breakMinutes: 60,
        isNight: true,
      }),
    ).toThrow(new RegExp(`${MAX_NIGHT_HOURS} saati aşamaz`));
  });

  it("ARA DİNLENME KANUNÎ ASGARİNİN ALTINA İNEMEZ — md. 68", () => {
    expect(requiredBreakMinutes(3)).toBe(15);
    expect(requiredBreakMinutes(7)).toBe(30);
    expect(requiredBreakMinutes(9)).toBe(60);
    expect(() => validateShift({ ...gunduz, breakMinutes: 30 })).toThrow(/en az 60 dakika/);
  });

  it("GÜNLÜK 11 SAAT SINIRI — md. 63", () => {
    expect(() =>
      validateShift({
        code: "V9",
        name: "Uzun",
        startsAt: "06:00",
        endsAt: "19:00",
        breakMinutes: 60,
        isNight: false,
      }),
    ).toThrow(/11 saati aşamaz/);
  });

  it("GECE SAATİNE GİRİP İŞARETLENMEMİŞ VARDİYA UYARIR", () => {
    // İşaretlenmezse 7,5 saat sınırı hiç kontrol edilmez ve kural
    // sessizce atlanır.
    const r = validateShift({
      code: "V2",
      name: "Akşam",
      startsAt: "23:00",
      endsAt: "06:00",
      breakMinutes: 30,
      isNight: false,
    });
    expect(r.warnings[0]).toContain("gece vardiyası olarak");
  });

  it("geçerli vardiya uyarısız geçer", () => {
    expect(validateShift(gunduz)).toMatchObject({ hours: 8, warnings: [] });
  });

  it("ara dinlenme vardiyadan uzun olamaz", () => {
    expect(() =>
      shiftHours({ ...gunduz, startsAt: "08:00", endsAt: "09:00", breakMinutes: 90 }),
    ).toThrow(ShiftError);
  });

  it("geçersiz saat biçimi reddedilir", () => {
    expect(() => shiftHours({ ...gunduz, startsAt: "8:00" })).toThrow(/Geçersiz saat/);
    expect(() => shiftHours({ ...gunduz, startsAt: "25:00" })).toThrow(ShiftError);
  });

  it("haftalık 45 saat üstü mesai sayılır — md. 63", () => {
    expect(weeklyOvertime(48)).toEqual({ overtime: 3, exceedsLimit: true });
    expect(weeklyOvertime(45)).toEqual({ overtime: 0, exceedsLimit: false });
  });
});
