/**
 * AuthStore — Postgres adaptörü (kontrol düzlemi).
 *
 * Mantık `src/auth/session.ts`'te ve testlidir; burada yalnızca kalıcılık var.
 *
 * İKİ NOKTA:
 *
 *  1. KİLİT SAYACI ATOMİK ARTIRILIR.
 *     `upsert` + `increment` tek ifadede yapılır. Okuyup-yazsaydık, eşzamanlı
 *     beş deneme sayacı 1'e yazardı ve kilit hiç devreye girmezdi — kaba
 *     kuvvet saldırısı tam olarak eşzamanlı yapılır.
 *
 *  2. ROL DİZİSİ DOĞRULANIR.
 *     Veritabanındaki `roles` bir string dizisidir. Bilinmeyen bir rol —
 *     yazım hatası, silinmiş rol, elle SQL — sessizce yetkisiz bir principal
 *     üretmemeli; bilinmeyen değerler ATILIR, kalan boşsa üyelik yok sayılır.
 */

import type {
  AuthStore,
  MembershipRecord,
  SessionRecord,
  UserRecord,
} from "../auth/session.js";
import { LOCKOUT_MS, MAX_FAILED_ATTEMPTS } from "../auth/session.js";
import type { PasswordResetStore, ResetRecord } from "../auth/password-reset.js";
import { ROLE_PERMISSIONS } from "../kernel/rbac.js";
import type { RoleId } from "../kernel/types.js";
import type { SharedDb } from "./client.js";

const KNOWN_ROLES = new Set(Object.keys(ROLE_PERMISSIONS));

function toRoles(values: readonly string[]): readonly RoleId[] {
  return values.filter((v): v is RoleId => KNOWN_ROLES.has(v));
}

export class PrismaAuthStore implements AuthStore, PasswordResetStore {
  readonly #db: SharedDb;

  constructor(db: SharedDb) {
    this.#db = db;
  }

  async findUserByEmail(email: string): Promise<UserRecord | null> {
    const row = await this.#db.user.findUnique({ where: { email } });
    return row ? toUser(row) : null;
  }

  async findUserById(id: string): Promise<UserRecord | null> {
    const row = await this.#db.user.findUnique({ where: { id } });
    return row ? toUser(row) : null;
  }

  async findMembership(userId: string, tenantId: string): Promise<MembershipRecord | null> {
    const row = await this.#db.membership.findUnique({
      where: { userId_tenantId: { userId, tenantId } },
    });
    if (!row) return null;
    return { tenantId: row.tenantId, roles: toRoles(row.roles), isActive: row.isActive };
  }

  async listMemberships(
    userId: string,
  ): Promise<readonly (MembershipRecord & { name: string })[]> {
    const rows = await this.#db.membership.findMany({
      where: { userId, isActive: true },
      include: { tenant: true },
      orderBy: { createdAt: "asc" },
    });
    return rows
      // Askıya alınmış veya arşivlenmiş tenant'a giriş yapılmaz.
      .filter((r) => r.tenant.status === "active")
      .map((r) => ({
        tenantId: r.tenantId,
        roles: toRoles(r.roles),
        isActive: r.isActive,
        name: r.tenant.name,
      }));
  }

  async createSession(input: Omit<SessionRecord, "revokedAt">): Promise<void> {
    await this.#db.session.create({
      data: {
        id: input.id,
        userId: input.userId,
        tenantId: input.tenantId,
        tokenHash: input.tokenHash,
        expiresAt: new Date(input.expiresAt),
      },
    });
  }

  async findSessionByHash(tokenHash: string): Promise<SessionRecord | null> {
    const row = await this.#db.session.findUnique({ where: { tokenHash } });
    if (!row) return null;
    return {
      id: row.id,
      userId: row.userId,
      tenantId: row.tenantId,
      tokenHash: row.tokenHash,
      expiresAt: row.expiresAt.toISOString(),
      revokedAt: row.revokedAt?.toISOString() ?? null,
    };
  }

  async revokeSession(id: string, at: string): Promise<void> {
    await this.#db.session.updateMany({
      where: { id, revokedAt: null },
      data: { revokedAt: new Date(at) },
    });
  }

  /** Bir kullanıcının TÜM oturumlarını düşürür (parola değişimi, çıkış-hepsi). */
  async revokeAllForUser(userId: string, at: string): Promise<number> {
    const r = await this.#db.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date(at) },
    });
    return r.count;
  }

  async failedAttempts(email: string): Promise<{ count: number; lockedUntil: string | null }> {
    const row = await this.#db.loginAttempt.findUnique({ where: { email } });
    if (!row) return { count: 0, lockedUntil: null };
    return { count: row.count, lockedUntil: row.lockedUntil?.toISOString() ?? null };
  }

  async recordFailure(email: string, at: string): Promise<void> {
    const when = new Date(at);
    // ATOMİK: okuma-yazma arası yarış yok.
    const row = await this.#db.loginAttempt.upsert({
      where: { email },
      create: { email, count: 1, lastFailureAt: when },
      update: { count: { increment: 1 }, lastFailureAt: when },
    });
    if (row.count >= MAX_FAILED_ATTEMPTS && !row.lockedUntil) {
      await this.#db.loginAttempt.update({
        where: { email },
        data: { lockedUntil: new Date(when.getTime() + LOCKOUT_MS) },
      });
    }
  }

  async clearFailures(email: string): Promise<void> {
    await this.#db.loginAttempt.deleteMany({ where: { email } });
  }

  async lastTotpStep(userId: string): Promise<number | null> {
    const row = await this.#db.user.findUnique({
      where: { id: userId },
      select: { lastTotpStep: true },
    });
    return row?.lastTotpStep === null || row?.lastTotpStep === undefined
      ? null
      : Number(row.lastTotpStep);
  }

  async recordTotpStep(userId: string, step: number): Promise<void> {
    await this.#db.user.update({
      where: { id: userId },
      data: { lastTotpStep: BigInt(step) },
    });
  }

  // ─────────────── Parola sıfırlama ───────────────

  async invalidateAll(userId: string, at: string): Promise<void> {
    // Silmek yerine KULLANILMIŞ işaretlenir: kimin ne zaman kod istediği
    // denetim izinin parçasıdır ve silinirse kaybolur.
    await this.#db.passwordReset.updateMany({
      where: { userId, usedAt: null },
      data: { usedAt: new Date(at) },
    });
  }

  async create(input: {
    userId: string;
    codeHash: string;
    expiresAt: string;
    issuedBy: string | null;
  }): Promise<void> {
    await this.#db.passwordReset.create({
      data: {
        userId: input.userId,
        codeHash: input.codeHash,
        expiresAt: new Date(input.expiresAt),
        issuedBy: input.issuedBy,
      },
    });
  }

  async findByHash(codeHash: string): Promise<ResetRecord | null> {
    const row = await this.#db.passwordReset.findUnique({ where: { codeHash } });
    if (!row) return null;
    return {
      id: row.id,
      userId: row.userId,
      codeHash: row.codeHash,
      expiresAt: row.expiresAt.toISOString(),
      usedAt: row.usedAt?.toISOString() ?? null,
    };
  }

  async markUsed(id: string, at: string): Promise<void> {
    await this.#db.passwordReset.updateMany({
      where: { id, usedAt: null },
      data: { usedAt: new Date(at) },
    });
  }

  /**
   * Parolayı değiştirir ve TÜM OTURUMLARI DÜŞÜRÜR.
   *
   * Tek transaction: parola değişip oturumlar açık kalırsa, sıfırlamanın
   * sebebi olan şüphe giderilmemiş olur.
   */
  async applyNewPassword(userId: string, passwordHash: string, at: string): Promise<void> {
    await this.#db.$transaction(async (tx) => {
      const user = await tx.user.update({
        where: { id: userId },
        data: { passwordHash },
        select: { email: true },
      });

      await tx.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date(at) },
      });

      // Kilit sayacı da sıfırlanır: parolası yeni sıfırlanmış bir hesabın
      // hâlâ kilitli olması, kullanıcıyı yöneticiyi ikinci kez aramaya
      // zorlar ve sıfırlamayı işe yaramaz kılar.
      await tx.loginAttempt.deleteMany({ where: { email: user.email } });
    });
  }

  /** Süresi geçmiş oturumları siler — bakım işi. */
  async pruneExpiredSessions(before: Date): Promise<number> {
    const r = await this.#db.session.deleteMany({ where: { expiresAt: { lt: before } } });
    return r.count;
  }
}

function toUser(row: {
  id: string;
  email: string;
  displayName: string;
  passwordHash: string | null;
  totpSecret: string | null;
  isActive: boolean;
}): UserRecord {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    passwordHash: row.passwordHash,
    totpSecret: row.totpSecret,
    isActive: row.isActive,
  };
}
