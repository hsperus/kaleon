/**
 * Parola sıfırlama.
 *
 * E-posta altyapısı yok; akış Türk KOBİ gerçeğine göre kuruldu: kullanıcı
 * yöneticiyi arar, yönetici tek kullanımlık kod üretir, telefonla iletir.
 * SMTP eklendiğinde aynı kod e-postayla gider — akış değişmez.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  RESET_TTL_MS,
  generateResetCode,
  hashResetCode,
  issueResetCode,
  redeemResetCode,
  type PasswordResetStore,
  type ResetRecord,
} from "../src/auth/password-reset.js";
import { verifyPassword } from "../src/auth/password.js";

describe("kod üretimi", () => {
  it("KARIŞAN KARAKTERLER YOK", () => {
    // Kod telefonda okunuyor; "sıfır mı O mu" diye sorulan her kod,
    // yanlış girilen bir koddur.
    for (let i = 0; i < 200; i++) {
      expect(generateResetCode()).not.toMatch(/[0O1IL]/);
    }
  });

  it("gruplanmış ve okunabilir", () => {
    expect(generateResetCode()).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{2}$/);
  });

  it("her seferinde farklı", () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateResetCode()));
    expect(seen.size).toBe(200);
  });

  it("TİRE VE BÜYÜK/KÜÇÜK HARF FARKI ÖNEMSİZ", () => {
    // "Tire var mıydı" diye sorulmasın.
    const a = hashResetCode("ABCD-EFGH-JK");
    expect(hashResetCode("abcdefghjk")).toBe(a);
    expect(hashResetCode("ABCD EFGH JK")).toBe(a);
  });
});

/** Bellek içi depo — sözleşmeyi sınamak için. */
class MemoryResetStore implements PasswordResetStore {
  records: ResetRecord[] = [];
  passwords = new Map<string, string>();
  revokedAt: string | null = null;

  async invalidateAll(userId: string, at: string) {
    this.records = this.records.map((r) =>
      r.userId === userId && !r.usedAt ? { ...r, usedAt: at } : r,
    );
  }
  async create(input: { userId: string; codeHash: string; expiresAt: string }) {
    this.records.push({
      id: `r-${this.records.length}`,
      userId: input.userId,
      codeHash: input.codeHash,
      expiresAt: input.expiresAt,
      usedAt: null,
    });
  }
  async findByHash(codeHash: string) {
    return this.records.find((r) => r.codeHash === codeHash) ?? null;
  }
  async markUsed(id: string, at: string) {
    this.records = this.records.map((r) => (r.id === id ? { ...r, usedAt: at } : r));
  }
  async applyNewPassword(userId: string, passwordHash: string, at: string) {
    this.passwords.set(userId, passwordHash);
    this.revokedAt = at;
  }
}

const NOW = () => new Date("2026-05-16T08:00:00.000Z");

describe("sıfırlama akışı", () => {
  let store: MemoryResetStore;

  beforeEach(() => {
    store = new MemoryResetStore();
  });

  it("kod üretilir ve kullanılır", async () => {
    const { code } = await issueResetCode(store, { userId: "u1", issuedBy: "admin", now: NOW });
    const r = await redeemResetCode(store, {
      code,
      newPassword: "YeniGucluParola2026",
      now: NOW,
    });
    expect(r).toMatchObject({ ok: true, userId: "u1" });
    const hash = store.passwords.get("u1")!;
    expect((await verifyPassword("YeniGucluParola2026", hash)).valid).toBe(true);
  }, 20_000);

  it("KOD DÜZ SAKLANMAZ", async () => {
    const { code } = await issueResetCode(store, { userId: "u1", issuedBy: null, now: NOW });
    expect(JSON.stringify(store.records)).not.toContain(code.replace(/-/g, ""));
    expect(store.records[0]!.codeHash).toBe(hashResetCode(code));
  });

  it("KOD TEK KULLANIMLIK", async () => {
    // Telefonla iletilmiş bir kod, iletildiği kanalda kaldığı sürece
    // geçerli bir arka kapı olmamalı.
    const { code } = await issueResetCode(store, { userId: "u1", issuedBy: null, now: NOW });
    await redeemResetCode(store, { code, newPassword: "YeniGucluParola2026", now: NOW });
    const second = await redeemResetCode(store, {
      code,
      newPassword: "BaskaParola2026xx",
      now: NOW,
    });
    expect(second).toMatchObject({ ok: false, reason: "used" });
  }, 20_000);

  it("SÜRESİ DOLAN KOD ÇALIŞMAZ", async () => {
    const { code } = await issueResetCode(store, { userId: "u1", issuedBy: null, now: NOW });
    const later = () => new Date(NOW().getTime() + RESET_TTL_MS + 1000);
    expect(await redeemResetCode(store, { code, newPassword: "YeniGucluParola2026", now: later })).toMatchObject({
      ok: false,
      reason: "expired",
    });
  });

  it("YENİ KOD ESKİLERİ İPTAL EDER", async () => {
    // Birden çok geçerli kod dolaşması, hangisinin kimde olduğunu
    // takip edilemez kılar.
    const first = await issueResetCode(store, { userId: "u1", issuedBy: null, now: NOW });
    await issueResetCode(store, { userId: "u1", issuedBy: null, now: NOW });
    expect(
      await redeemResetCode(store, { code: first.code, newPassword: "YeniGucluParola2026", now: NOW }),
    ).toMatchObject({ ok: false, reason: "used" });
  });

  it("bilinmeyen kod reddedilir", async () => {
    expect(
      await redeemResetCode(store, { code: "ZZZZ-ZZZZ-ZZ", newPassword: "YeniGucluParola2026", now: NOW }),
    ).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("zayıf parola reddedilir ve KOD TÜKENMEZ", async () => {
    // Parolası kısa diye kodu yakmak, kullanıcıyı yöneticiyi tekrar
    // aramaya zorlar.
    const { code } = await issueResetCode(store, { userId: "u1", issuedBy: null, now: NOW });
    expect(await redeemResetCode(store, { code, newPassword: "kisa", now: NOW })).toMatchObject({
      ok: false,
      reason: "weak_password",
    });
    expect(store.records[0]!.usedAt).toBe(null);
    expect(
      await redeemResetCode(store, { code, newPassword: "YeniGucluParola2026", now: NOW }),
    ).toMatchObject({ ok: true });
  }, 20_000);

  it("SIFIRLAMA OTURUMLARI DÜŞÜRÜR", async () => {
    // Parola değişiminin sebebi çoğu zaman "birileri girmiş olabilir"
    // şüphesidir; eski oturumlar açık kalırsa sıfırlamanın anlamı olmaz.
    const { code } = await issueResetCode(store, { userId: "u1", issuedBy: null, now: NOW });
    await redeemResetCode(store, { code, newPassword: "YeniGucluParola2026", now: NOW });
    expect(store.revokedAt).toBe(NOW().toISOString());
  }, 20_000);
});
