/**
 * Operations repository — Postgres adaptörü.
 *
 * ═══ NEDEN ADVISORY LOCK, NEDEN `SELECT ... FOR UPDATE` DEĞİL ═══
 *
 * Negatif stok değişmezi "bakiyeyi oku → karar ver → yaz" dizisini korumayı
 * gerektirir. Satır kilidi bunun için yanlış araçtır, iki nedenle:
 *
 *  1. Defter APPEND-ONLY. Bakiye tek bir satırda durmaz, N geçmiş hareketin
 *     toplamıdır. `FOR UPDATE` ile korumak, o kalemin TÜM geçmişini kilitlemek
 *     demektir — bir yılın sonunda milyonlarca satır. Kilit maliyeti hareket
 *     sayısıyla büyür; oysa korunan şey tek bir sayıdır.
 *  2. Anahtar HENÜZ BOŞ olabilir. Yeni bir kalem+lokasyon için hiç hareket
 *     yoksa `FOR UPDATE` hiçbir satır kilitlemez ve hiçbir şey serileştirmez.
 *     Var olmayan satır kilitlenemez.
 *
 * `pg_advisory_xact_lock` satırı değil ANAHTARI kilitler: kalem+lokasyon+parti.
 * O(1), satır olsa da olmasa da çalışır ve korunan değişmezin sınırını
 * doğrudan ifade eder. Aynı stok anahtarındaki hareketler sıraya girer,
 * farklı anahtarlar paralel akar.
 *
 * Bakiye ayrıca JS'te değil SQL'de toplanır (`SUM(quantity * direction)`),
 * böylece kayan nokta birikmesi olmaz ve tek indeksli sorguya iner.
 */

import type { AuthorityLevel } from "../kernel/types.js";
import type { TenantDb } from "./client.js";
import type {
  OperationsRepository,
  WorkOrderFilter,
} from "../modules/operations/repository.js";
import {
  MOVEMENT_TYPES,
  validateMovement,
  type PostMovementInput,
  type StockKey,
  type StockMovement,
} from "../modules/operations/stock-ledger.js";
import type {
  GateDecision,
  QualityGate,
  WorkOrder,
  WorkOrderOperation,
} from "../modules/operations/work-order.js";
import { BusinessRuleError } from "../kernel/errors.js";

type WorkOrderRow = {
  id: string;
  itemId: string;
  quantity: unknown;
  status: string;
  bomRevision: string | null;
  bomFrozenAt: Date | null;
  overrideCount: number;
  version: number;
  operations: {
    seq: number;
    workCenter: string;
    description: string;
    gateCharacteristic: string | null;
    gateDecidedBy: string | null;
    gateToleranceMin: unknown;
    gateToleranceMax: unknown;
    gateToleranceUnit: string | null;
    state: string;
    confirmedQty: unknown;
    scrapQty: unknown;
    gateDecision: unknown;
  }[];
};

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

function toDomain(row: WorkOrderRow): WorkOrder {
  return {
    id: row.id,
    itemId: row.itemId,
    quantity: num(row.quantity),
    status: row.status as WorkOrder["status"],
    bomRevision: row.bomRevision,
    bomFrozenAt: row.bomFrozenAt ? row.bomFrozenAt.toISOString() : null,
    overrideCount: row.overrideCount,
    operations: [...row.operations]
      .sort((a, b) => a.seq - b.seq)
      .map((o): WorkOrderOperation => {
        const gate: QualityGate | null = o.gateCharacteristic
          ? {
              characteristic: o.gateCharacteristic,
              decidedBy: (o.gateDecidedBy ?? "quality:gate.release") as QualityGate["decidedBy"],
              ...(o.gateToleranceMin !== null && o.gateToleranceMax !== null
                ? {
                    tolerance: {
                      min: num(o.gateToleranceMin),
                      max: num(o.gateToleranceMax),
                      unit: o.gateToleranceUnit ?? "",
                    },
                  }
                : {}),
            }
          : null;
        return {
          seq: o.seq,
          workCenter: o.workCenter,
          description: o.description,
          gate,
          state: o.state as WorkOrderOperation["state"],
          confirmedQty: num(o.confirmedQty),
          scrapQty: num(o.scrapQty),
          gateDecision: (o.gateDecision as GateDecision | null) ?? null,
        };
      }),
  };
}

/** Stok anahtarını kilit için tek bir metne indirger. */
function lockKey(k: StockKey): string {
  return `stock:${k.itemId}|${k.locationId}|${k.batchId ?? ""}`;
}

export class PrismaOperationsRepository implements OperationsRepository {
  readonly #db: TenantDb;

  constructor(db: TenantDb) {
    this.#db = db;
  }

  async getWorkOrder(_tenantId: string, id: string): Promise<WorkOrder | null> {
    const row = await this.#db.workOrder.findUnique({
      where: { id },
      include: { operations: true },
    });
    return row ? toDomain(row as unknown as WorkOrderRow) : null;
  }

  async listWorkOrders(_tenantId: string, filter: WorkOrderFilter): Promise<readonly WorkOrder[]> {
    const rows = await this.#db.workOrder.findMany({
      where: {
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.workCenter ? { operations: { some: { workCenter: filter.workCenter } } } : {}),
      },
      include: { operations: true },
      orderBy: { id: "asc" },
    });
    return rows.map((r) => toDomain(r as unknown as WorkOrderRow));
  }

  async saveWorkOrder(_tenantId: string, wo: WorkOrder): Promise<void> {
    await this.#db.$transaction(async (tx) => {
      await tx.workOrder.upsert({
        where: { id: wo.id },
        create: {
          id: wo.id,
          itemId: wo.itemId,
          quantity: wo.quantity,
          status: wo.status,
          bomRevision: wo.bomRevision,
          bomFrozenAt: wo.bomFrozenAt ? new Date(wo.bomFrozenAt) : null,
          overrideCount: wo.overrideCount,
        },
        update: {
          status: wo.status,
          bomRevision: wo.bomRevision,
          bomFrozenAt: wo.bomFrozenAt ? new Date(wo.bomFrozenAt) : null,
          overrideCount: wo.overrideCount,
        },
      });
      await tx.workOrderOperation.deleteMany({ where: { workOrderId: wo.id } });
      await tx.workOrderOperation.createMany({
        data: wo.operations.map((o) => ({
          workOrderId: wo.id,
          seq: o.seq,
          workCenter: o.workCenter,
          description: o.description,
          gateCharacteristic: o.gate?.characteristic ?? null,
          gateDecidedBy: o.gate?.decidedBy ?? null,
          gateToleranceMin: o.gate?.tolerance?.min ?? null,
          gateToleranceMax: o.gate?.tolerance?.max ?? null,
          gateToleranceUnit: o.gate?.tolerance?.unit ?? null,
          state: o.state,
          confirmedQty: o.confirmedQty,
          scrapQty: o.scrapQty,
          gateDecision: (o.gateDecision ?? null) as never,
        })),
      });
    });
  }

  /**
   * İş emrini atomik dönüştürür.
   *
   * Burada satır VAR olduğu için `FOR UPDATE` doğru araçtır; ayrıca
   * `version` iyimser kilidi, kaybolan güncellemeyi yakalar.
   */
  async mutateWorkOrder(
    tenantId: string,
    id: string,
    mutate: (wo: WorkOrder) => WorkOrder,
  ): Promise<WorkOrder> {
    return this.#db.$transaction(async (tx) => {
      const locked = await tx.$queryRawUnsafe<{ id: string; version: number }[]>(
        `SELECT id, version FROM work_orders WHERE id = $1 FOR UPDATE`,
        id,
      );
      if (locked.length === 0) {
        throw new BusinessRuleError(`İş emri bulunamadı: ${id}`, "work_order_not_found");
      }

      const row = await tx.workOrder.findUniqueOrThrow({
        where: { id },
        include: { operations: true },
      });
      const next = mutate(toDomain(row as unknown as WorkOrderRow));

      const updated = await tx.workOrder.updateMany({
        where: { id, version: locked[0]!.version },
        data: {
          status: next.status,
          bomRevision: next.bomRevision,
          bomFrozenAt: next.bomFrozenAt ? new Date(next.bomFrozenAt) : null,
          overrideCount: next.overrideCount,
          version: { increment: 1 },
        },
      });
      if (updated.count !== 1) {
        throw new BusinessRuleError(
          "İş emri başka bir işlem tarafından değiştirildi; tekrar deneyin.",
          "concurrent_modification",
        );
      }

      for (const op of next.operations) {
        await tx.workOrderOperation.update({
          where: { workOrderId_seq: { workOrderId: id, seq: op.seq } },
          data: {
            state: op.state,
            confirmedQty: op.confirmedQty,
            scrapQty: op.scrapQty,
            gateDecision: (op.gateDecision ?? null) as never,
          },
        });
      }
      return next;
    });
  }

  async activeBomRevision(_tenantId: string, itemId: string): Promise<string> {
    const row = await this.#db.bomRevision.findFirst({
      where: { itemId, isActive: true },
      orderBy: { createdAt: "desc" },
    });
    return row?.revision ?? "R1";
  }

  async balance(_tenantId: string, key: StockKey): Promise<number> {
    const rows = await this.#db.$queryRawUnsafe<{ balance: number }[]>(
      `SELECT COALESCE(SUM(quantity * direction), 0)::float8 AS balance
         FROM stock_movements
        WHERE item_id = $1 AND location_id = $2
          AND batch_id IS NOT DISTINCT FROM $3`,
      key.itemId,
      key.locationId,
      key.batchId,
    );
    return rows[0]?.balance ?? 0;
  }

  async movements(_tenantId: string, key: Partial<StockKey>): Promise<readonly StockMovement[]> {
    const rows = await this.#db.stockMovement.findMany({
      where: {
        ...(key.itemId !== undefined ? { itemId: key.itemId } : {}),
        ...(key.locationId !== undefined ? { locationId: key.locationId } : {}),
        ...(key.batchId !== undefined ? { batchId: key.batchId } : {}),
      },
      orderBy: { at: "asc" },
    });
    return rows.map((r) => ({
      id: r.id,
      at: r.at.toISOString(),
      itemId: r.itemId,
      locationId: r.locationId,
      batchId: r.batchId,
      quantity: num(r.quantity),
      movementType: r.movementType,
      reference: r.referenceKind
        ? { kind: r.referenceKind as StockMovement["reference"] extends null ? never : NonNullable<StockMovement["reference"]>["kind"], id: r.referenceId ?? "" }
        : null,
      userId: r.userId,
      reason: r.reason,
      reversalOf: r.reversalOf,
    }));
  }

  /**
   * Stok hareketi — değişmez ANAHTAR kilidi altında uygulanır.
   * Dosya başındaki açıklama bu fonksiyon içindir.
   */
  async postMovement(
    tenantId: string,
    input: PostMovementInput,
    opts: { authority: AuthorityLevel },
  ): Promise<StockMovement> {
    const key: StockKey = {
      itemId: input.itemId,
      locationId: input.locationId,
      batchId: input.batchId ?? null,
    };

    return this.#db.$transaction(async (tx) => {
      // 1) ANAHTAR kilidi — satır olmasa bile çalışır. FOR UPDATE burada yetmez.
      await tx.$executeRawUnsafe(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        lockKey(key),
      );

      // 2) Bakiyeyi SQL'de topla — JS'te kayan nokta birikmesi yok.
      const balanceRows = await tx.$queryRawUnsafe<{ balance: number }[]>(
        `SELECT COALESCE(SUM(quantity * direction), 0)::float8 AS balance
           FROM stock_movements
          WHERE item_id = $1 AND location_id = $2
            AND batch_id IS NOT DISTINCT FROM $3`,
        key.itemId,
        key.locationId,
        key.batchId,
      );
      const currentBalance = balanceRows[0]?.balance ?? 0;

      // 3) İptal ediliyorsa aslını ve daha önce iptal edilip edilmediğini getir.
      let original: StockMovement | null = null;
      let alreadyReversed = false;
      if (input.reversalOf) {
        const row = await tx.stockMovement.findUnique({ where: { id: input.reversalOf } });
        if (row) {
          original = {
            id: row.id,
            at: row.at.toISOString(),
            itemId: row.itemId,
            locationId: row.locationId,
            batchId: row.batchId,
            quantity: num(row.quantity),
            movementType: row.movementType,
            reference: null,
            userId: row.userId,
            reason: row.reason,
            reversalOf: row.reversalOf,
          };
          alreadyReversed =
            (await tx.stockMovement.count({ where: { reversalOf: row.id } })) > 0;
        }
      }

      // 4) Kuralı uygula — bellek adaptörüyle AYNI fonksiyon.
      const id = input.id || crypto.randomUUID();
      const movement = validateMovement({ ...input, id }, {
        authority: opts.authority,
        currentBalance,
        original,
        alreadyReversed,
      });

      // 5) Yaz. `direction` tipten türetilip saklanır; bakiye sorgusu böylece
      //    uygulama koduna bağımlı olmaz.
      const type = MOVEMENT_TYPES[movement.movementType]!;
      await tx.stockMovement.create({
        data: {
          id: movement.id,
          at: new Date(movement.at),
          itemId: movement.itemId,
          locationId: movement.locationId,
          batchId: movement.batchId,
          quantity: movement.quantity,
          direction: type.sign,
          movementType: movement.movementType,
          referenceKind: movement.reference?.kind ?? null,
          referenceId: movement.reference?.id ?? null,
          userId: movement.userId,
          reason: movement.reason,
          reversalOf: movement.reversalOf,
        },
      });

      return movement;
    });
  }
}
