/**
 * Onay bekleyen işlem deposu.
 *
 * `consume` TEK SQL İFADESİDİR. İki adım olsaydı (oku, sonra güncelle) iki
 * eşzamanlı "onayla" isteği de "pending" görür ve ikisi de faturayı keserdi.
 * Koşullu UPDATE, satırı kilitleyip yalnızca bir isteğe 1 satır döndürür.
 */

import type { TenantDb } from "./client.js";
import {
  PENDING_TTL_MS,
  type PendingAction,
  type PendingStatus,
  type PendingStore,
} from "../kernel/pending.js";
import type { AuthorityLevel } from "../kernel/types.js";

export class PrismaPendingStore implements PendingStore {
  readonly #db: TenantDb;

  constructor(db: TenantDb) {
    this.#db = db;
  }

  async create(action: {
    id: string;
    toolName: string;
    input: unknown;
    authority: AuthorityLevel;
    userId: string;
    correlationId: string;
    conversationId?: string | null;
    createdAt: Date;
    expiresAt: Date;
  }): Promise<void> {
    await this.#db.pendingAction.create({
      data: {
        id: action.id,
        toolName: action.toolName,
        input: action.input as never,
        authority: action.authority,
        userId: action.userId,
        correlationId: action.correlationId,
        conversationId: action.conversationId ?? null,
        status: "pending",
        createdAt: action.createdAt,
        expiresAt: action.expiresAt,
      },
    });
  }

  async find(id: string, userId: string): Promise<PendingAction | null> {
    const row = await this.#db.pendingAction.findFirst({ where: { id, userId } });
    return row ? toAction(row) : null;
  }

  /**
   * Onaylar ve tüketir.
   *
   * Koşullar SQL'in İÇİNDE: kullanıcı eşleşmeli, durum `pending` olmalı ve
   * süresi dolmamış olmalı. Uygulamada kontrol edilseydi, kontrolle güncelleme
   * arasında ikinci bir istek geçebilirdi.
   */
  async consume(id: string, userId: string, now: Date): Promise<boolean> {
    const rows = await this.#db.$queryRaw<{ id: string }[]>`
      UPDATE "pending_actions"
         SET "status" = 'confirmed', "confirmed_at" = ${now}
       WHERE "id" = ${id}::uuid
         AND "user_id" = ${userId}::uuid
         AND "status" = 'pending'
         AND "expires_at" > ${now}
      RETURNING "id"`;
    return rows.length === 1;
  }

  async release(id: string, userId: string): Promise<void> {
    await this.#db.$executeRaw`
      UPDATE "pending_actions"
         SET "status" = 'pending', "confirmed_at" = NULL
       WHERE "id" = ${id}::uuid
         AND "user_id" = ${userId}::uuid
         AND "status" = 'confirmed'`;
  }

  async cancel(id: string, userId: string): Promise<boolean> {
    const rows = await this.#db.$queryRaw<{ id: string }[]>`
      UPDATE "pending_actions"
         SET "status" = 'cancelled'
       WHERE "id" = ${id}::uuid
         AND "user_id" = ${userId}::uuid
         AND "status" = 'pending'
      RETURNING "id"`;
    return rows.length === 1;
  }

  async listPending(userId: string, now: Date): Promise<readonly PendingAction[]> {
    const rows = await this.#db.pendingAction.findMany({
      where: { userId, status: "pending", expiresAt: { gt: now } },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
    return rows.map(toAction);
  }

  /**
   * Süresi dolanları işaretler.
   *
   * SİLİNMEZ, İŞARETLENİR: "kullanıcı bir fatura hazırladı ama onaylamadı"
   * bilgisi denetimde anlamlıdır ve silinirse kaybolur.
   */
  async expire(now: Date): Promise<number> {
    const res = await this.#db.pendingAction.updateMany({
      where: { status: "pending", expiresAt: { lte: now } },
      data: { status: "expired" },
    });
    return res.count;
  }
}

/** Test ve tek örnekli çalıştırma için bellek içi karşılık. */
export class InMemoryPendingStore implements PendingStore {
  readonly #rows = new Map<string, PendingAction & { userId: string }>();

  async create(action: Parameters<PendingStore["create"]>[0]): Promise<void> {
    this.#rows.set(action.id, {
      id: action.id,
      toolName: action.toolName,
      input: action.input,
      authority: action.authority,
      userId: action.userId,
      correlationId: action.correlationId,
      conversationId: action.conversationId ?? null,
      status: "pending",
      createdAt: action.createdAt.toISOString(),
      expiresAt: action.expiresAt.toISOString(),
    });
  }

  async find(id: string, userId: string): Promise<PendingAction | null> {
    const row = this.#rows.get(id);
    return row && row.userId === userId ? row : null;
  }

  async consume(id: string, userId: string, now: Date): Promise<boolean> {
    const row = this.#rows.get(id);
    if (!row || row.userId !== userId) return false;
    if (row.status !== "pending") return false;
    if (new Date(row.expiresAt).getTime() <= now.getTime()) return false;
    this.#rows.set(id, { ...row, status: "confirmed" });
    return true;
  }

  async release(id: string, userId: string): Promise<void> {
    const row = this.#rows.get(id);
    if (row && row.userId === userId && row.status === "confirmed") {
      this.#rows.set(id, { ...row, status: "pending" });
    }
  }

  async cancel(id: string, userId: string): Promise<boolean> {
    const row = this.#rows.get(id);
    if (!row || row.userId !== userId || row.status !== "pending") return false;
    this.#rows.set(id, { ...row, status: "cancelled" });
    return true;
  }

  async listPending(userId: string, now: Date): Promise<readonly PendingAction[]> {
    return [...this.#rows.values()].filter(
      (r) =>
        r.userId === userId &&
        r.status === "pending" &&
        new Date(r.expiresAt).getTime() > now.getTime(),
    );
  }

  async expire(now: Date): Promise<number> {
    let n = 0;
    for (const [id, row] of this.#rows) {
      if (row.status === "pending" && new Date(row.expiresAt).getTime() <= now.getTime()) {
        this.#rows.set(id, { ...row, status: "expired" });
        n += 1;
      }
    }
    return n;
  }
}

function toAction(row: {
  id: string;
  toolName: string;
  input: unknown;
  authority: number;
  userId: string;
  correlationId: string;
  conversationId: string | null;
  status: string;
  createdAt: Date;
  expiresAt: Date;
}): PendingAction {
  return {
    id: row.id,
    toolName: row.toolName,
    input: row.input,
    authority: row.authority as AuthorityLevel,
    userId: row.userId,
    correlationId: row.correlationId,
    conversationId: row.conversationId,
    status: row.status as PendingStatus,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  };
}

export { PENDING_TTL_MS };
