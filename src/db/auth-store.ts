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
import { ROLE_PERMISSIONS } from "../kernel/rbac.js";
import type { RoleId } from "../kernel/types.js";
import type { SharedDb } from "./client.js";

const KNOWN_ROLES = new Set(Object.keys(ROLE_PERMISSIONS));

function toRoles(values: readonly string[]): readonly RoleId[] {
  return values.filter((v): v is RoleId => KNOWN_ROLES.has(v));
}

export class PrismaAuthStore implements AuthStore {
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
