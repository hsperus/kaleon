/**
 * İzleme kalıcılığı.
 *
 * İZLEMENİN DEĞERİ SESSİZ ÇALIŞMASINDADIR; o yüzden ne zaman koştuğu,
 * ne gördüğü ve kaç kez tetiklendiği KAYIT ALTINDADIR. Kaydı olmayan
 * bir izleme, çalışıp çalışmadığı bilinmeyen bir izlemedir ve
 * kullanıcı ona güvenemez.
 */

import type { TenantDb } from "./client.js";
import type { SignalLevel } from "../modules/briefing/sentinels.js";
import type { WatchDefinition, WatchOperator } from "../modules/briefing/watch.js";

export class WatchRepositoryError extends Error {
  readonly code = "watch_store";
  constructor(message: string) {
    super(message);
    this.name = "WatchRepositoryError";
  }
}

export interface WatchRow extends WatchDefinition {
  readonly ownerUserId: string;
  readonly isActive: boolean;
  readonly lastCheckedAt: string | null;
  readonly lastFiredAt: string | null;
  readonly fireCount: number;
}

function toDefinition(r: {
  id: string;
  name: string;
  tool: string;
  input: unknown;
  path: string;
  operator: string;
  threshold: number | null;
  level: number;
  message: string;
  lastValue: number | null;
  ownerUserId: string;
  isActive: boolean;
  lastCheckedAt: Date | null;
  lastFiredAt: Date | null;
  fireCount: number;
}): WatchRow {
  return {
    id: r.id,
    name: r.name,
    tool: r.tool,
    input: r.input ?? {},
    path: r.path,
    operator: r.operator as WatchOperator,
    threshold: r.threshold,
    level: Math.min(2, Math.max(0, r.level)) as SignalLevel,
    message: r.message,
    lastValue: r.lastValue,
    ownerUserId: r.ownerUserId,
    isActive: r.isActive,
    lastCheckedAt: r.lastCheckedAt?.toISOString() ?? null,
    lastFiredAt: r.lastFiredAt?.toISOString() ?? null,
    fireCount: r.fireCount,
  };
}

export class WatchRepository {
  readonly #db: TenantDb;

  constructor(db: TenantDb) {
    this.#db = db;
  }

  async create(input: {
    name: string;
    tool: string;
    toolInput: unknown;
    path: string;
    operator: WatchOperator;
    threshold: number | null;
    level: SignalLevel;
    message: string;
    ownerUserId: string;
  }): Promise<WatchRow> {
    const existing = await this.#db.watch.findUnique({
      where: { ownerUserId_name: { ownerUserId: input.ownerUserId, name: input.name } },
    });
    if (existing) {
      throw new WatchRepositoryError(
        `"${input.name}" adıyla bir izlemeniz zaten var. Aynı uyarı iki kez ` +
          `çıkmasın diye ikinci kez kurulamaz; önce eskisini kaldırın.`,
      );
    }

    const row = await this.#db.watch.create({
      data: {
        name: input.name,
        tool: input.tool,
        input: (input.toolInput ?? {}) as never,
        path: input.path,
        operator: input.operator,
        threshold: input.threshold,
        level: input.level,
        message: input.message,
        ownerUserId: input.ownerUserId,
        createdBy: input.ownerUserId,
      },
    });
    return toDefinition(row as never);
  }

  /** Bir kullanıcının izlemeleri. */
  async listFor(ownerUserId: string): Promise<readonly WatchRow[]> {
    const rows = await this.#db.watch.findMany({
      where: { ownerUserId },
      orderBy: { createdAt: "asc" },
      take: 100,
    });
    return rows.map((r) => toDefinition(r as never));
  }

  /** Brifingte koşacak aktif izlemeler. */
  async activeFor(ownerUserId: string): Promise<readonly WatchRow[]> {
    const rows = await this.#db.watch.findMany({
      where: { ownerUserId, isActive: true },
      orderBy: { level: "desc" },
      // Brifing bir saniyede bitmeli: sınırsız izleme, açılışı kilitler.
      take: 25,
    });
    return rows.map((r) => toDefinition(r as never));
  }

  /**
   * Kiracıdaki TÜM aktif izlemeler — zamanlanmış koşu için.
   *
   * `activeFor` kullanıcı başına ve 25 ile sınırlı çünkü brifing bir
   * saniyede bitmeli. Zamanlanmış koşunun böyle bir kısıtı yok ve
   * olmamalı: kullanıcı başına kesilen bir liste, kesilen kısmı hiç
   * kontrol edilmeyen izlemeler hâline getirirdi.
   */
  async allActive(): Promise<readonly WatchRow[]> {
    const rows = await this.#db.watch.findMany({
      where: { isActive: true },
      orderBy: [{ ownerUserId: "asc" }, { level: "desc" }],
      take: 1000,
    });
    return rows.map((r) => toDefinition(r as never));
  }

  async remove(ownerUserId: string, name: string): Promise<boolean> {
    const r = await this.#db.watch.deleteMany({ where: { ownerUserId, name } });
    return r.count > 0;
  }

  async setActive(ownerUserId: string, name: string, active: boolean): Promise<boolean> {
    const r = await this.#db.watch.updateMany({
      where: { ownerUserId, name },
      data: { isActive: active },
    });
    return r.count > 0;
  }

  /**
   * Koşu sonucunu işler.
   *
   * SON DEĞER HER KOŞUDA GÜNCELLENİR, tetiklense de tetiklenmese de:
   * "değişirse" izlemesi ancak böyle çalışır. Yalnızca tetiklendiğinde
   * güncellenseydi, değer bir kez değişip sabitlendiğinde izleme her
   * brifingte tekrar tetiklenirdi.
   */
  async recordCheck(id: string, value: number | null, fired: boolean): Promise<void> {
    await this.#db.watch.update({
      where: { id },
      data: {
        lastValue: value,
        lastCheckedAt: new Date(),
        ...(fired ? { lastFiredAt: new Date(), fireCount: { increment: 1 } } : {}),
      },
    });
  }
}
