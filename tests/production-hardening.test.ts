/**
 * Üretim sertleştirme kontrolleri.
 *
 * Buradaki testler ürünün ne YAPTIĞINI değil, kötü günde nasıl
 * DAVRANDIĞINI sınar: taşan tutar, büyüyen tablo, sızan log.
 */

import { describe, expect, it, vi } from "vitest";
import {
  MAX_SAFE_MONEY,
  MoneyPrecisionError,
  toMoney,
  toMoneyRequired,
  toQuantity,
} from "../src/db/decimal.js";
import { MAX_ROWS, limitCaveat } from "../src/db/query-limits.js";
import { log } from "../src/server/log.js";

/** Prisma Decimal'i taklit eder: değeri string olarak taşır. */
const dec = (v: string) => ({ toString: () => v });

describe("parasal hassasiyet", () => {
  it("normal tutarlar kuruşuna kadar doğru", () => {
    expect(toMoney(dec("12400000.00"))).toBe(12_400_000);
    expect(toMoney(dec("126050.55"))).toBe(126_050.55);
    expect(toMoney(dec("-1234.56"))).toBe(-1234.56);
  });

  it("KAYAN NOKTA ARTIĞI TEMİZLENİR", () => {
    // 0.1 + 0.2 tipi artıklar bir muhasebe sisteminde mutabakat bozar.
    expect(toMoney(dec("0.30000000000000004"))).toBe(0.3);
  });

  it("null KORUNUR — sıfıra çevrilmez", () => {
    // "tutar yok" ile "tutar sıfır" farklı cevaplar üretir (sözleşme cezası).
    expect(toMoney(null)).toBe(null);
    expect(toMoney(undefined)).toBe(null);
  });

  it("HASSASİYETİ AŞAN TUTAR SESSİZCE YUVARLANMAZ, HATA VERİR", () => {
    // Sessiz bozulmayı gürültülü arızaya çevirmek doğru takas.
    expect(() => toMoney(dec("99999999999999999.99"))).toThrow(MoneyPrecisionError);
  });

  it("güvenli sınır iki ondalık için doğru", () => {
    expect(MAX_SAFE_MONEY).toBeGreaterThan(90_000_000_000_000);
    expect(() => toMoney(dec(String(MAX_SAFE_MONEY - 1)))).not.toThrow();
  });

  it("sayı olmayan değer hata verir", () => {
    expect(() => toMoney(dec("abc"))).toThrow(MoneyPrecisionError);
  });

  it("zorunlu alan boş gelirse hata", () => {
    expect(() => toMoneyRequired(null, "bakiye")).toThrow(/bakiye boş olamaz/);
    expect(toMoneyRequired(dec("5.00"), "bakiye")).toBe(5);
  });

  it("miktar alanı daha dar sınırla korunur", () => {
    expect(toQuantity(dec("1234.5678"))).toBe(1234.5678);
    expect(() => toQuantity(dec("99999999999999999"))).toThrow(MoneyPrecisionError);
  });
});

describe("sorgu sınırları", () => {
  it("sınırın altında uyarı YOK", () => {
    expect(limitCaveat(10, "Siparişler")).toBe(null);
    expect(limitCaveat(MAX_ROWS - 1, "Siparişler")).toBe(null);
  });

  it("SINIRA DAYANILDIYSA SESSİZ KALINMAZ", () => {
    // "İlk 5000 kayda bakıldı" demek, hiç söylememekten iyidir.
    const c = limitCaveat(MAX_ROWS, "Siparişler");
    expect(c).toContain("Siparişler");
    expect(c).toContain("eksik olabilir");
  });

  it("sınır makul bir büyüklükte", () => {
    expect(MAX_ROWS).toBeGreaterThanOrEqual(1000);
    expect(MAX_ROWS).toBeLessThanOrEqual(50_000);
  });
});

describe("log disiplini", () => {
  function capture(fn: () => void): string {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a) => lines.push(a.join(" ")));
    const spyE = vi.spyOn(console, "error").mockImplementation((...a) => lines.push(a.join(" ")));
    const spyW = vi.spyOn(console, "warn").mockImplementation((...a) => lines.push(a.join(" ")));
    try {
      fn();
    } finally {
      spy.mockRestore();
      spyE.mockRestore();
      spyW.mockRestore();
    }
    return lines.join("\n");
  }

  it("GİZLİ ALANLAR LOGA YAZILMAZ", () => {
    // Log, maaş ve bakiye görebilecek kişilerin erişemediği bir yerde durur;
    // oraya iş verisi yazmak yetkilendirmeyi arkadan dolaşmaktır.
    const out = capture(() =>
      log.info("giriş denemesi", {
        userId: "u1",
        password: "CokGizliParola",
        totpCode: "123456",
        token: "abc",
        content: "cari listesi tüm satırlar",
      }),
    );
    expect(out).not.toContain("CokGizliParola");
    expect(out).not.toContain("123456");
    expect(out).not.toContain("cari listesi");
    expect(out).toContain("[gizlendi]");
    expect(out).toContain("u1");
  });

  it("uzun metin kırpılır — tek satır logu boğmaz", () => {
    const out = capture(() => log.info("uzun", { note: "x".repeat(2000) }));
    expect(out.length).toBeLessThan(1200);
    expect(out).toContain("…");
  });

  it("HATA REFERANSI ÜRETİLİR — destek çağrısında logdaki satır bulunabilsin", () => {
    let ref = "";
    const out = capture(() => {
      ref = log.fail("patladı", new Error("veritabanı düştü"), { correlationId: "c1" });
    });
    expect(ref).toMatch(/^[0-9a-f]{8}$/);
    expect(out).toContain(ref);
    expect(out).toContain("veritabanı düştü");
  });

  it("yığın izi kısaltılır", () => {
    const out = capture(() => log.fail("patladı", new Error("hata")));
    // Tam yığın izi log satırını megabaytlara çıkarır.
    expect(out.split("|").length).toBeLessThanOrEqual(6);
  });
});

/**
 * Bakım işi.
 *
 * `pruneExpiredSessions` YAZILMIŞ AMA HİÇ ÇAĞRILMIYORDU. Tablo sonsuza
 * kadar büyür ve KVKK açısından gereksiz kişisel veri saklanırdı.
 */
describe.skipIf(!process.env["SHARED_DATABASE_URL"])("oturum temizliği", () => {
  it("SÜRESİ DOLMUŞ OTURUMLAR SİLİNİR, GEÇERLİLER KALIR", async () => {
    const { PrismaClient } = await import("../src/db/generated/shared/index.js");
    const { PrismaAuthStore } = await import("../src/db/auth-store.js");
    const { hashPassword } = await import("../src/auth/password.js");
    const db = new PrismaClient();
    const store = new PrismaAuthStore(db);
    const email = "temizlik@kaelon.test";

    try {
      const user = await db.user.upsert({
        where: { email },
        create: { email, displayName: "Temizlik", passwordHash: await hashPassword("TemizlikParola2026!") },
        update: {},
      });
      const tenant = await db.tenant.findFirstOrThrow({ where: { slug: "demo" } });
      await db.session.deleteMany({ where: { userId: user.id } });

      const base = {
        userId: user.id,
        tenantId: tenant.id,
      };
      await db.session.createMany({
        data: [
          { ...base, tokenHash: "eski-1", expiresAt: new Date("2020-01-01") },
          { ...base, tokenHash: "eski-2", expiresAt: new Date("2020-01-02") },
          { ...base, tokenHash: "gecerli", expiresAt: new Date("2099-01-01") },
        ],
      });

      const pruned = await store.pruneExpiredSessions(new Date());
      expect(pruned).toBeGreaterThanOrEqual(2);

      const left = await db.session.findMany({ where: { userId: user.id } });
      expect(left.map((s) => s.tokenHash)).toEqual(["gecerli"]);
    } finally {
      await db.user.deleteMany({ where: { email } });
      await db.$disconnect();
    }
  }, 30_000);
});
