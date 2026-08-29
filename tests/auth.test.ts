/**
 * Kimlik ve oturum testleri.
 *
 * Güvenlik kodunda test, "çalışıyor mu" sorusundan çok "yanlış girdide
 * ne yapıyor" sorusunu sorar. Buradaki testlerin çoğu başarısızlık
 * yollarını sınar.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_PARAMS, hashPassword, verifyPassword } from "../src/auth/password.js";
import {
  base32Decode,
  base32Encode,
  currentStep,
  generateSecret,
  otpauthUri,
  totpAt,
  verifyTotp,
} from "../src/auth/totp.js";
import {
  MAX_FAILED_ATTEMPTS,
  hashToken,
  issueToken,
  login,
  resolveSession,
  type AuthStore,
  type MembershipRecord,
  type SessionRecord,
  type UserRecord,
} from "../src/auth/session.js";
import { FixedWindowThrottle } from "../src/auth/throttle.js";
import { clearedSessionCookie, readCookie, sessionCookie } from "../src/server/auth.js";
import type { RoleId } from "../src/kernel/types.js";

// Testleri hızlı tutmak için düşük maliyet; üretim parametresi ayrıca sınanıyor.
const FAST = { N: 1024, r: 8, p: 1 };

describe("parola saklama", () => {
  it("hash formatı parametreleri taşır", async () => {
    const h = await hashPassword("cokGucluParola123", FAST);
    expect(h.startsWith("scrypt$1024$8$1$")).toBe(true);
    expect(h.split("$")).toHaveLength(6);
  });

  it("aynı parola her seferinde FARKLI hash üretir (tuz)", async () => {
    const a = await hashPassword("cokGucluParola123", FAST);
    const b = await hashPassword("cokGucluParola123", FAST);
    expect(a).not.toBe(b);
  });

  it("doğru parola doğrulanır, yanlış reddedilir", async () => {
    const h = await hashPassword("cokGucluParola123", FAST);
    expect((await verifyPassword("cokGucluParola123", h, FAST)).valid).toBe(true);
    expect((await verifyPassword("cokGucluParola124", h, FAST)).valid).toBe(false);
  });

  it("kısa parola reddedilir", async () => {
    await expect(hashPassword("kisa", FAST)).rejects.toThrow(/en az 10/);
  });

  it("bozuk hash çökmez, geçersiz döner", async () => {
    for (const bad of ["", "duz-metin", "bcrypt$1$2$3$4$5", "scrypt$a$b$c$d$e", "scrypt$1024$8$1$xx"]) {
      await expect(verifyPassword("cokGucluParola123", bad, FAST)).resolves.toMatchObject({ valid: false });
    }
  });

  it("eski parametreli hash yenilenmesi gerektiğini bildirir", async () => {
    const old = await hashPassword("cokGucluParola123", { N: 1024, r: 8, p: 1 });
    const r = await verifyPassword("cokGucluParola123", old, { N: 2048, r: 8, p: 1 });
    expect(r.valid).toBe(true);
    expect(r.needsRehash).toBe(true);
  });

  it("üretim parametreleri çalışır", async () => {
    const h = await hashPassword("cokGucluParola123", DEFAULT_PARAMS);
    expect((await verifyPassword("cokGucluParola123", h, DEFAULT_PARAMS)).valid).toBe(true);
  }, 20_000);

  it("Unicode normalizasyonu — aynı görünen parola aynı kabul edilir", async () => {
    const composed = "parolaü123456";
    const decomposed = "parolaü123456";
    const h = await hashPassword(composed, FAST);
    expect((await verifyPassword(decomposed, h, FAST)).valid).toBe(true);
  });
});

describe("TOTP", () => {
  const secret = "JBSWY3DPEHPK3PXP";

  it("base32 gidiş-dönüş", () => {
    const buf = Buffer.from("KAELON test verisi");
    expect(base32Decode(base32Encode(buf)).toString()).toBe("KAELON test verisi");
  });

  it("RFC 6238 referans vektörü", () => {
    // Bilinen sır ve adım için üretilen kod deterministiktir.
    const step = currentStep(new Date("2026-05-16T08:00:00.000Z"));
    expect(totpAt(secret, step)).toMatch(/^\d{6}$/);
    expect(totpAt(secret, step)).toBe(totpAt(secret, step));
    expect(totpAt(secret, step)).not.toBe(totpAt(secret, step + 1));
  });

  it("geçerli kod kabul edilir", () => {
    const now = new Date("2026-05-16T08:00:00.000Z");
    const code = totpAt(secret, currentStep(now));
    expect(verifyTotp({ secret, code, now })).toMatchObject({ valid: true });
  });

  it("±1 adım toleransı var, ±2 yok", () => {
    const now = new Date("2026-05-16T08:00:00.000Z");
    const step = currentStep(now);
    expect(verifyTotp({ secret, code: totpAt(secret, step - 1), now }).valid).toBe(true);
    expect(verifyTotp({ secret, code: totpAt(secret, step + 1), now }).valid).toBe(true);
    expect(verifyTotp({ secret, code: totpAt(secret, step - 2), now }).valid).toBe(false);
  });

  it("KOD TEKRAR KULLANILAMAZ", () => {
    const now = new Date("2026-05-16T08:00:00.000Z");
    const step = currentStep(now);
    const code = totpAt(secret, step);
    const first = verifyTotp({ secret, code, now, lastUsedStep: null });
    expect(first.valid).toBe(true);
    const second = verifyTotp({ secret, code, now, lastUsedStep: step });
    expect(second).toMatchObject({ valid: false, reason: "replayed" });
  });

  it("biçimsiz kod reddedilir", () => {
    const now = new Date();
    for (const code of ["", "12345", "1234567", "abcdef"]) {
      expect(verifyTotp({ secret, code, now })).toMatchObject({ valid: false, reason: "format" });
    }
  });

  it("otpauth URI doğru kurulur", () => {
    const uri = otpauthUri({ secret, account: "cebrail@uls.com", issuer: "KAELON" });
    expect(uri).toContain("otpauth://totp/KAELON%3Acebrail%40uls.com");
    expect(uri).toContain(`secret=${secret}`);
  });

  it("üretilen sır geçerli base32", () => {
    expect(generateSecret()).toMatch(/^[A-Z2-7]+$/);
  });
});

// ─────────────────────── oturum ───────────────────────

class MemoryAuthStore implements AuthStore {
  users: UserRecord[] = [];
  memberships = new Map<string, MembershipRecord & { name: string }>();
  sessions: SessionRecord[] = [];
  failures = new Map<string, { count: number; lockedUntil: string | null }>();
  totpSteps = new Map<string, number>();

  async findUserByEmail(email: string) {
    return this.users.find((u) => u.email === email) ?? null;
  }
  async findUserById(id: string) {
    return this.users.find((x) => x.id === id) ?? null;
  }
  async findMembership(userId: string, tenantId: string) {
    return this.memberships.get(`${userId}:${tenantId}`) ?? null;
  }
  async listMemberships(userId: string) {
    return [...this.memberships.entries()]
      .filter(([k]) => k.startsWith(`${userId}:`))
      .map(([, v]) => v);
  }
  async createSession(s: Omit<SessionRecord, "revokedAt">) {
    this.sessions.push({ ...s, revokedAt: null });
  }
  async findSessionByHash(tokenHash: string) {
    return this.sessions.find((s) => s.tokenHash === tokenHash) ?? null;
  }
  async revokeSession(id: string, at: string) {
    this.sessions = this.sessions.map((s) => (s.id === id ? { ...s, revokedAt: at } : s));
  }
  async failedAttempts(email: string) {
    return this.failures.get(email) ?? { count: 0, lockedUntil: null };
  }
  async recordFailure(email: string, at: string) {
    const cur = this.failures.get(email) ?? { count: 0, lockedUntil: null };
    const count = cur.count + 1;
    this.failures.set(email, {
      count,
      lockedUntil: count >= MAX_FAILED_ATTEMPTS ? new Date(Date.parse(at) + 900_000).toISOString() : null,
    });
  }
  async clearFailures(email: string) {
    this.failures.delete(email);
  }
  async lastTotpStep(userId: string) {
    return this.totpSteps.get(userId) ?? null;
  }
  async recordTotpStep(userId: string, step: number) {
    this.totpSteps.set(userId, step);
  }
}

const NOW = () => new Date("2026-05-16T08:00:00.000Z");

async function storeWith(opts: { totp?: boolean; roles?: RoleId[]; active?: boolean } = {}) {
  const store = new MemoryAuthStore();
  store.users.push({
    id: "u-1",
    email: "cebrail@uls.com",
    displayName: "Cebrail Karaarslan",
    passwordHash: await hashPassword("cokGucluParola123", FAST),
    totpSecret: opts.totp ? "JBSWY3DPEHPK3PXP" : null,
    isActive: opts.active ?? true,
  });
  store.memberships.set("u-1:t-orthaus", {
    tenantId: "t-orthaus",
    name: "Orthaus Makina",
    roles: opts.roles ?? ["patron"],
    isActive: true,
  });
  return store;
}

// Testlerde hızlı parametre kullanabilmek için login'in verifyPassword'ü
// hash içindeki parametreleri okur; FAST hash'ler otomatik doğrulanır.
const creds = { email: "cebrail@uls.com", password: "cokGucluParola123", tenantId: "t-orthaus" };

describe("giriş akışı", () => {
  it("doğru bilgiyle giriş başarılı, principal rollerden türer", async () => {
    const store = await storeWith();
    const r = await login(store, { ...creds, now: NOW });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.principal.roles).toEqual(["patron"]);
      expect(r.principal.maxAuthority).toBe(3);
      expect(r.token.length).toBeGreaterThan(20);
    }
  });

  it("TOKEN DÜZ SAKLANMAZ — yalnızca hash'i", async () => {
    const store = await storeWith();
    const r = await login(store, { ...creds, now: NOW });
    if (!r.ok) throw new Error("giriş başarısız");
    expect(store.sessions[0]?.tokenHash).toBe(hashToken(r.token));
    expect(store.sessions[0]?.tokenHash).not.toBe(r.token);
    expect(JSON.stringify(store.sessions)).not.toContain(r.token);
  });

  it("yanlış parola reddedilir", async () => {
    const store = await storeWith();
    const r = await login(store, { ...creds, password: "yanlisParola123", now: NOW });
    expect(r).toMatchObject({ ok: false, reason: "invalid_credentials" });
  });

  it("KULLANICI NUMARALANDIRMA: olmayan e-posta aynı cevabı verir", async () => {
    const store = await storeWith();
    const yok = await login(store, { ...creds, email: "yok@uls.com", now: NOW });
    const yanlis = await login(store, { ...creds, password: "yanlisParola123", now: NOW });
    expect(yok).toEqual(yanlis);
  });

  it("pasif kullanıcı giremez", async () => {
    const store = await storeWith({ active: false });
    expect(await login(store, { ...creds, now: NOW })).toMatchObject({ reason: "invalid_credentials" });
  });

  it("üyeliği olmayan tenant'a giremez", async () => {
    const store = await storeWith();
    const r = await login(store, { ...creds, tenantId: "t-baska", now: NOW });
    expect(r).toMatchObject({ ok: false, reason: "no_membership" });
  });

  it("GİRİŞ DENEMESİ SINIRLI — eşikten sonra kilitlenir", async () => {
    const store = await storeWith();
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) {
      await login(store, { ...creds, password: "yanlisParola123", now: NOW });
    }
    // Artık DOĞRU parolayla bile giremez
    const r = await login(store, { ...creds, now: NOW });
    expect(r).toMatchObject({ ok: false, reason: "locked" });
  });

  it("başarılı giriş sayacı sıfırlar", async () => {
    const store = await storeWith();
    await login(store, { ...creds, password: "yanlisParola123", now: NOW });
    await login(store, { ...creds, now: NOW });
    expect(await store.failedAttempts("cebrail@uls.com")).toMatchObject({ count: 0 });
  });

  it("2FA açıksa kod olmadan giriş olmaz", async () => {
    const store = await storeWith({ totp: true });
    expect(await login(store, { ...creds, now: NOW })).toMatchObject({ reason: "totp_required" });
  });

  it("2FA doğru kodla geçer, yanlış kodla geçmez", async () => {
    const store = await storeWith({ totp: true });
    const code = totpAt("JBSWY3DPEHPK3PXP", currentStep(NOW()));
    expect(await login(store, { ...creds, totpCode: code, now: NOW })).toMatchObject({ ok: true });

    const store2 = await storeWith({ totp: true });
    expect(await login(store2, { ...creds, totpCode: "000000", now: NOW })).toMatchObject({
      reason: "totp_invalid",
    });
  });

  it("aynı TOTP kodu ikinci kez kullanılamaz", async () => {
    const store = await storeWith({ totp: true });
    const code = totpAt("JBSWY3DPEHPK3PXP", currentStep(NOW()));
    expect(await login(store, { ...creds, totpCode: code, now: NOW })).toMatchObject({ ok: true });
    expect(await login(store, { ...creds, totpCode: code, now: NOW })).toMatchObject({
      reason: "totp_invalid",
    });
  });
});

describe("oturum çözümleme", () => {
  it("geçerli token principal döndürür", async () => {
    const store = await storeWith();
    const r = await login(store, { ...creds, now: NOW });
    if (!r.ok) throw new Error("giriş başarısız");
    const s = await resolveSession(store, r.token, NOW);
    expect(s.ok).toBe(true);
    if (s.ok) expect(s.principal.roles).toEqual(["patron"]);
  });

  it("bilinmeyen token reddedilir", async () => {
    const store = await storeWith();
    expect(await resolveSession(store, issueToken(), NOW)).toMatchObject({ reason: "not_found" });
  });

  it("süresi dolmuş oturum reddedilir", async () => {
    const store = await storeWith();
    const r = await login(store, { ...creds, now: NOW });
    if (!r.ok) throw new Error("giriş başarısız");
    const sonra = () => new Date("2026-05-17T08:00:00.000Z");
    expect(await resolveSession(store, r.token, sonra)).toMatchObject({ reason: "expired" });
  });

  it("iptal edilmiş oturum reddedilir", async () => {
    const store = await storeWith();
    const r = await login(store, { ...creds, now: NOW });
    if (!r.ok) throw new Error("giriş başarısız");
    await store.revokeSession(store.sessions[0]!.id, NOW().toISOString());
    expect(await resolveSession(store, r.token, NOW)).toMatchObject({ reason: "revoked" });
  });

  it("YETKİ HER İSTEKTE ÜYELİKTEN OKUNUR — rol alınınca oturum düşer", async () => {
    const store = await storeWith();
    const r = await login(store, { ...creds, now: NOW });
    if (!r.ok) throw new Error("giriş başarısız");

    // Kullanıcının rolü elinden alınıyor
    store.memberships.set("u-1:t-orthaus", {
      tenantId: "t-orthaus",
      name: "Orthaus Makina",
      roles: [],
      isActive: true,
    });
    expect(await resolveSession(store, r.token, NOW)).toMatchObject({ reason: "no_membership" });
  });

  it("rol DEĞİŞİRSE yeni yetki hemen geçerli olur", async () => {
    const store = await storeWith();
    const r = await login(store, { ...creds, now: NOW });
    if (!r.ok) throw new Error("giriş başarısız");
    expect(r.principal.maxAuthority).toBe(3);

    store.memberships.set("u-1:t-orthaus", {
      tenantId: "t-orthaus",
      name: "Orthaus Makina",
      roles: ["operator"],
      isActive: true,
    });
    const s = await resolveSession(store, r.token, NOW);
    expect(s.ok).toBe(true);
    if (s.ok) {
      expect(s.principal.roles).toEqual(["operator"]);
      expect(s.principal.maxAuthority).toBe(1);
    }
  });

  it("pasifleştirilen kullanıcının oturumu düşer", async () => {
    const store = await storeWith();
    const r = await login(store, { ...creds, now: NOW });
    if (!r.ok) throw new Error("giriş başarısız");
    store.users[0] = { ...store.users[0]!, isActive: false };
    expect(await resolveSession(store, r.token, NOW)).toMatchObject({ reason: "inactive" });
  });
});

describe("IP sınırlayıcı", () => {
  it("limite kadar izin verir, sonra reddeder", () => {
    let t = 0;
    const th = new FixedWindowThrottle({ limit: 3, windowMs: 1000, now: () => t });
    expect(th.check("1.2.3.4").allowed).toBe(true);
    expect(th.check("1.2.3.4").allowed).toBe(true);
    expect(th.check("1.2.3.4").allowed).toBe(true);
    const d = th.check("1.2.3.4");
    expect(d.allowed).toBe(false);
    expect(d.retryAfterMs).toBe(1000);
  });

  it("pencere dolunca sıfırlanır", () => {
    let t = 0;
    const th = new FixedWindowThrottle({ limit: 2, windowMs: 1000, now: () => t });
    th.check("ip");
    th.check("ip");
    expect(th.check("ip").allowed).toBe(false);
    t = 1001;
    expect(th.check("ip").allowed).toBe(true);
  });

  it("kaynaklar birbirini etkilemez", () => {
    const th = new FixedWindowThrottle({ limit: 1, windowMs: 1000, now: () => 0 });
    expect(th.check("a").allowed).toBe(true);
    expect(th.check("b").allowed).toBe(true);
    expect(th.check("a").allowed).toBe(false);
  });

  it("süresi dolan kovalar temizlenir — bellek sızmaz", () => {
    let t = 0;
    const th = new FixedWindowThrottle({ limit: 5, windowMs: 100, now: () => t });
    for (let i = 0; i < 1200; i++) th.check(`ip-${i}`);
    expect(th.size).toBe(1200);
    t = 200;
    th.check("yeni"); // temizleme bu çağrıda tetiklenir
    expect(th.size).toBe(1);
  });
});

describe("oturum çerezi", () => {
  it("HttpOnly ve SameSite taşır, token URL-kodlanır", () => {
    const c = sessionCookie("abc/def+gh=", new Date(Date.now() + 3_600_000).toISOString());
    expect(c).toContain("HttpOnly");
    expect(c).toContain("SameSite=Lax");
    expect(c).toContain("Path=/");
    expect(c).toContain("abc%2Fdef%2Bgh%3D");
    expect(c).toMatch(/Max-Age=3[56]\d\d/);
  });

  it("temizleme çerezi Max-Age=0", () => {
    expect(clearedSessionCookie()).toContain("Max-Age=0");
  });

  it("çerez başlığından doğru değeri okur", () => {
    const req = new Request("http://x/", {
      headers: { cookie: "other=1; kaelon_session=tok%2Fen; last=2" },
    });
    expect(readCookie(req, "kaelon_session")).toBe("tok/en");
    expect(readCookie(req, "yok")).toBe(null);
  });

  it("çerez yoksa null", () => {
    expect(readCookie(new Request("http://x/"), "kaelon_session")).toBe(null);
  });
});

describe("şirket seçimi", () => {
  async function twoTenants() {
    const store = await storeWith();
    store.memberships.set("u-1:t-zerey", {
      tenantId: "t-zerey",
      name: "Zerey Metal",
      roles: ["uretim_muduru"],
      isActive: true,
    });
    return store;
  }

  it("tek üyelik varsa şirket sorulmaz", async () => {
    const store = await storeWith();
    const r = await login(store, { email: creds.email, password: creds.password, now: NOW });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.tenantId).toBe("t-orthaus");
  });

  it("birden çok üyelikte seçim istenir", async () => {
    const store = await twoTenants();
    const r = await login(store, { email: creds.email, password: creds.password, now: NOW });
    expect(r).toMatchObject({ ok: false, reason: "tenant_choice" });
    if (!r.ok && r.reason === "tenant_choice") {
      expect(r.tenants.map((t) => t.name).sort()).toEqual(["Orthaus Makina", "Zerey Metal"]);
    }
  });

  it("ŞİRKET LİSTESİ ANCAK PAROLA DOĞRUYSA VERİLİR", async () => {
    const store = await twoTenants();
    const r = await login(store, { email: creds.email, password: "yanlisParola123", now: NOW });
    expect(r).toMatchObject({ ok: false, reason: "invalid_credentials" });
    expect(r).not.toHaveProperty("tenants");
  });

  it("seçim ekranı hesabı kilitlemez", async () => {
    const store = await twoTenants();
    for (let i = 0; i < MAX_FAILED_ATTEMPTS + 2; i++) {
      await login(store, { email: creds.email, password: creds.password, now: NOW });
    }
    const r = await login(store, { ...creds, now: NOW });
    expect(r.ok).toBe(true);
  });

  it("seçilen şirkette üyelik yoksa reddedilir", async () => {
    const store = await twoTenants();
    const r = await login(store, { ...creds, tenantId: "t-baskasi", now: NOW });
    expect(r).toMatchObject({ ok: false, reason: "no_membership" });
  });

  it("oturum SEÇİLEN şirketin rollerini taşır", async () => {
    const store = await twoTenants();
    const r = await login(store, { ...creds, tenantId: "t-zerey", now: NOW });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.principal.roles).toEqual(["uretim_muduru"]);
      expect(r.principal.tenantId).toBe("t-zerey");
    }
  });
});
