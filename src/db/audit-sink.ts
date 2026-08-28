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
}
