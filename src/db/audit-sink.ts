/**
 * Postgres audit sink.
 *
 * Arayüzde yalnızca `append` vardır (kernel/audit.ts) ve veritabanı seviyesinde
 * UPDATE/DELETE tetikleyiciyle reddedilir (db/provision.ts). Yani "iz bırakmayan
 * eylem yok" ilkesi hem uygulama hem veritabanı katmanında uygulanır.
 */

import type { AuditEntry, AuditSink } from "../kernel/audit.js";
import type { TenantDb } from "./client.js";

export class PostgresAuditSink implements AuditSink {
  readonly #db: TenantDb;

  constructor(db: TenantDb) {
    this.#db = db;
  }

  async append(entry: AuditEntry): Promise<void> {
    await this.#db.auditEntry.create({
      data: {
        id: entry.id,
        at: new Date(entry.at),
        userId: entry.userId,
        roles: [...entry.roles],
        channel: entry.channel,
        correlationId: entry.correlationId,
        toolName: entry.toolName,
        authority: entry.authority,
        outcome: entry.outcome,
        input: (entry.input ?? null) as never,
        resultSummary: (entry.resultSummary ?? null) as never,
        errorCode: entry.errorCode ?? null,
        durationMs: entry.durationMs,
        aiModel: entry.aiContext?.model ?? null,
        aiPromptVersion: entry.aiContext?.promptVersion ?? null,
        aiToolUseId: entry.aiContext?.toolUseId ?? null,
      },
    });
  }

  /**
   * Son kayıtlar — "her tool çağrısı iz bırakır" iddiasının arayüzdeki kanıtı.
   * Yalnızca OKUMA; bu tabloya uygulama katmanından yazma dışında hiçbir
   * işlem yapılamaz (veritabanı tetikleyicisi UPDATE/DELETE'i reddeder).
   */
  async recent(tenantId: string, limit = 25): Promise<readonly AuditEntry[]> {
    const rows = await this.#db.auditEntry.findMany({
      orderBy: { at: "desc" },
      take: Math.min(limit, 200),
    });
    // tenantId sütunda yok: her tenant kendi şemasında olduğu için kayıt
    // zaten o tenant'a aittir. Arayüz tipini karşılamak için bağlamdan gelir.
    return rows.map((r) => ({
      id: r.id,
      at: r.at.toISOString(),
      tenantId,
      userId: r.userId,
      roles: r.roles as never,
      channel: r.channel as never,
      correlationId: r.correlationId,
      toolName: r.toolName,
      authority: r.authority as never,
      outcome: r.outcome as never,
      input: r.input as never,
      resultSummary: (r.resultSummary ?? undefined) as never,
      errorCode: r.errorCode ?? undefined,
      durationMs: r.durationMs,
      ...(r.aiModel
        ? {
            aiContext: {
              model: r.aiModel,
              promptVersion: r.aiPromptVersion ?? "",
              toolUseId: r.aiToolUseId ?? "",
            },
          }
        : {}),
    })) as readonly AuditEntry[];
  }
}