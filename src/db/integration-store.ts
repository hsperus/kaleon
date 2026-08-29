/**
 * Entegrasyon store — Postgres adaptörü.
 *
 * İki ayrıntı önemli:
 *
 *  1. HAM VERİ YAZIMI KANONİK YAZIMDAN AYRI TRANSACTION'DADIR.
 *     Aynı transaction'a alınsaydı, kanonik yazım patladığında ham veri de
 *     geri alınırdı — ve boru hattının tüm amacı (kanıtı korumak) çökerdi.
 *     Ayrı olmaları bilinçlidir: ham veri her koşulda kalır.
 *
 *  2. IDEMPOTENCY VERİTABANI KISITINDA.
 *     `@@unique([source, externalId])` aynı belgenin iki kez yazılmasını
 *     engeller. Uygulama katmanındaki kontrol yalnızca hızlı yol; iki
 *     eşzamanlı senkron koşusunda gerçek savunma kısıttır.
 */

import { Prisma } from "./generated/tenant/index.js";
import type { TenantDb } from "./client.js";
import type { IntegrationStore, StoredRaw, SyncSummary } from "../modules/integration/pipeline.js";
import type { Invoice } from "../modules/documents/three-way-match.js";

export class PrismaIntegrationStore implements IntegrationStore {
  readonly #db: TenantDb;

  constructor(db: TenantDb) {
    this.#db = db;
  }

  async putRaw(input: {
    source: string;
    kind: string;
    externalId: string;
    receivedAt: string;
    payload: unknown;
    checksum: string;
  }): Promise<{ raw: StoredRaw; alreadyExisted: boolean }> {
    const existing = await this.#db.rawPayload.findUnique({
      where: { source_externalId: { source: input.source, externalId: input.externalId } },
    });
    if (existing) {
      return {
        raw: {
          id: existing.id,
          source: existing.source,
          externalId: existing.externalId,
          checksum: existing.checksum,
          status: existing.status as StoredRaw["status"],
        },
        alreadyExisted: true,
      };
    }

    try {
      const created = await this.#db.rawPayload.create({
        data: {
          source: input.source,
          kind: input.kind,
          externalId: input.externalId,
          receivedAt: new Date(input.receivedAt),
          payload: (input.payload ?? null) as never,
          checksum: input.checksum,
          status: "pending",
        },
      });
      return {
        raw: {
          id: created.id,
          source: created.source,
          externalId: created.externalId,
          checksum: created.checksum,
          status: "pending",
        },
        alreadyExisted: false,
      };
    } catch (e) {
      // Eşzamanlı koşu aynı belgeyi yazdıysa kısıt patlar; mevcut kaydı al.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        const row = await this.#db.rawPayload.findUniqueOrThrow({
          where: { source_externalId: { source: input.source, externalId: input.externalId } },
        });
        return {
          raw: {
            id: row.id,
            source: row.source,
            externalId: row.externalId,
            checksum: row.checksum,
            status: row.status as StoredRaw["status"],
          },
          alreadyExisted: true,
        };
      }
      throw e;
    }
  }

  async markRawStatus(id: string, status: "transformed" | "failed"): Promise<void> {
    await this.#db.rawPayload.update({ where: { id }, data: { status } });
  }

  async recordError(input: {
    rawPayloadId: string;
    stage: string;
    code: string;
    message: string;
    at: string;
  }): Promise<void> {
    await this.#db.integrationError.create({
      data: {
        rawPayloadId: input.rawPayloadId,
        stage: input.stage,
        code: input.code,
        message: input.message.slice(0, 2000),
        at: new Date(input.at),
      },
    });
  }

  /**
   * Kanonik faturayı yazar ve ham belgeye bağlar.
   * Mükerrer belge numarası kısıt tarafından yakalanır → `false` döner.
   */
  async writeCanonical(rawId: string, value: unknown): Promise<boolean> {
    const invoice = value as Invoice;
    try {
      await this.#db.invoice.create({
        data: {
          id: invoice.id,
          partnerId: invoice.partnerId,
          documentNo: invoice.documentNo,
          issuedAt: new Date(invoice.issuedAt),
          currency: invoice.currency,
          rawPayloadId: rawId,
          lines: {
            create: invoice.lines.map((l) => ({
              lineNo: l.lineNo,
              poId: l.poId,
              poLineNo: l.poLineNo,
              itemId: l.itemId,
              quantity: l.quantity,
              unitPrice: l.unitPrice,
              currency: l.currency,
            })),
          },
        },
      });
      return true;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        return false; // zaten var — idempotent
      }
      throw e;
    }
  }

  async startRun(input: { source: string; kind: string; startedAt: string }): Promise<string> {
    const run = await this.#db.syncRun.create({
      data: {
        source: input.source,
        kind: input.kind,
        startedAt: new Date(input.startedAt),
        status: "running",
      },
    });
    return run.id;
  }

  async finishRun(
    id: string,
    input: SyncSummary & { finishedAt: string; error?: string },
  ): Promise<void> {
    await this.#db.syncRun.update({
      where: { id },
      data: {
        finishedAt: new Date(input.finishedAt),
        status: input.status,
        fetched: input.fetched,
        created: input.created,
        skipped: input.skipped,
        failed: input.failed,
        error: input.error ?? null,
      },
    });
  }

  /** İnsan incelemesi bekleyen dönüşüm hataları. */
  async openErrors(): Promise<
    readonly { id: string; code: string; message: string; externalId: string; source: string }[]
  > {
    const rows = await this.#db.integrationError.findMany({
      where: { resolvedAt: null },
      include: { rawPayload: true },
      orderBy: { at: "desc" },
      take: 50,
    });
    return rows.map((r) => ({
      id: r.id,
      code: r.code,
      message: r.message,
      externalId: r.rawPayload.externalId,
      source: r.rawPayload.source,
    }));
  }
}
