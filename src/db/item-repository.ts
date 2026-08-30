/**
 * Malzeme kartı deposu.
 *
 * ÖLÇÜ BİRİMLERİ MALZEMEYLE BİRLİKTE OKUNUR. Ayrı bir sorgu olsaydı, her
 * miktar çevriminde ikinci bir gidiş-dönüş olurdu ve bir noktada birisi
 * "hızlı olsun" diye çevrimi atlardı. Birlikte gelmesi, atlanmasını zorlaştırır.
 */

import { Prisma } from "./generated/tenant/index.js";
import type { TenantDb } from "./client.js";
import { toMoney, toQuantity } from "./decimal.js";
import { setChangeActor } from "./change-log.js";
import {
  toBaseQuantity,
  validateItem,
  validateUnit,
  type ItemDraft,
  type UnitDefinition,
} from "../modules/master-data/item.js";

export interface ItemRecord {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly type: string;
  readonly baseUom: string;
  readonly valuationMethod: string;
  readonly standardCost: number | null;
  readonly movingAvgCost: number | null;
  readonly costCurrency: string;
  readonly batchManaged: boolean;
  readonly serialManaged: boolean;
  readonly shelfLifeDays: number | null;
  readonly procurementType: string;
  readonly leadTimeDays: number | null;
  readonly reorderPoint: number | null;
  readonly safetyStock: number | null;
  readonly isActive: boolean;
  readonly units: readonly UnitDefinition[];
}

export class ItemNotFoundError extends Error {
  readonly code = "item_not_found";
  constructor(ref: string) {
    super(`Malzeme bulunamadı: ${ref}`);
    this.name = "ItemNotFoundError";
  }
}

const INCLUDE_UNITS = { units: { select: { uom: true, factor: true } } } as const;

export class PrismaItemRepository {
  readonly #db: TenantDb;

  constructor(db: TenantDb) {
    this.#db = db;
  }

  async byCode(code: string): Promise<ItemRecord | null> {
    const row = await this.#db.item.findUnique({ where: { code }, include: INCLUDE_UNITS });
    return row ? toRecord(row) : null;
  }

  async byId(id: string): Promise<ItemRecord | null> {
    const row = await this.#db.item.findUnique({ where: { id }, include: INCLUDE_UNITS });
    return row ? toRecord(row) : null;
  }

  /** Koda göre arar; yoksa hata. Miktar çevriminde kullanılır. */
  async requireByCode(code: string): Promise<ItemRecord> {
    const item = await this.byCode(code);
    if (!item) throw new ItemNotFoundError(code);
    return item;
  }

  /**
   * Ada veya koda göre arama.
   *
   * Kod TAM eşleşir, ad ise normalize edilmiş sütunda aranır — kullanıcı
   * "şasi profili" yazınca "Şasi Profili" bulunmalı.
   */
  async search(query: string, limit = 25): Promise<readonly ItemRecord[]> {
    const rows = await this.#db.item.findMany({
      where: {
        isActive: true,
        OR: [
          { code: { equals: query, mode: "insensitive" } },
          { code: { startsWith: query, mode: "insensitive" } },
          { normalized: { contains: normalizeQuery(query) } },
        ],
      },
      include: INCLUDE_UNITS,
      orderBy: { code: "asc" },
      take: Math.min(limit, 200),
    });
    return rows.map(toRecord);
  }

  async create(
    draft: ItemDraft,
    units: readonly UnitDefinition[] = [],
    userId?: string,
  ): Promise<ItemRecord> {
    const item = validateItem(draft);
    for (const u of units) validateUnit(u, item.baseUom);

    try {
      // Aktör kaydı, yazmayla AYNI işlemde kurulur: `SET LOCAL` yalnızca
      // o işlem boyunca yaşar ve havuzdan gelen bir sonraki bağlantıya
      // sızmaz.
      const row = await this.#db.$transaction(async (tx) => {
        await setChangeActor(tx, userId);
        return tx.item.create({
        data: {
          code: item.code,
          name: item.name,
          normalized: item.normalized,
          type: item.type,
          baseUom: item.baseUom,
          valuationMethod: item.valuationMethod!,
          procurementType: item.procurementType!,
          batchManaged: item.batchManaged ?? false,
          serialManaged: item.serialManaged ?? false,
          shelfLifeDays: item.shelfLifeDays ?? null,
          leadTimeDays: item.leadTimeDays ?? null,
          units: { create: units.map((u) => ({ uom: u.uom, factor: u.factor })) },
        },
        include: INCLUDE_UNITS,
        });
      });
      return toRecord(row);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        throw new Error(`"${item.code}" kodlu malzeme zaten var.`);
      }
      throw e;
    }
  }

  /**
   * Miktarı temel birime çevirir.
   *
   * Bu metot deponun üstünde durur çünkü çevrim için malzemenin birimlerine
   * ihtiyaç var ve çağıranın onları ayrıca yüklemesini beklemek, bir gün
   * birinin çevrimi atlamasıyla sonuçlanır.
   */
  async toBase(itemCode: string, quantity: number, uom: string): Promise<number> {
    const item = await this.requireByCode(itemCode);
    return toBaseQuantity(quantity, uom, item.baseUom, item.units);
  }
}

function normalizeQuery(q: string): string {
  return q
    .toLocaleLowerCase("tr")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function toRecord(row: {
  id: string;
  code: string;
  name: string;
  type: string;
  baseUom: string;
  valuationMethod: string;
  standardCost: unknown;
  movingAvgCost: unknown;
  costCurrency: string;
  batchManaged: boolean;
  serialManaged: boolean;
  shelfLifeDays: number | null;
  procurementType: string;
  leadTimeDays: number | null;
  reorderPoint: unknown;
  safetyStock: unknown;
  isActive: boolean;
  units: { uom: string; factor: unknown }[];
}): ItemRecord {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    type: row.type,
    baseUom: row.baseUom,
    valuationMethod: row.valuationMethod,
    standardCost: toMoney(row.standardCost as never),
    movingAvgCost: toMoney(row.movingAvgCost as never),
    costCurrency: row.costCurrency,
    batchManaged: row.batchManaged,
    serialManaged: row.serialManaged,
    shelfLifeDays: row.shelfLifeDays,
    procurementType: row.procurementType,
    leadTimeDays: row.leadTimeDays,
    reorderPoint: toQuantity(row.reorderPoint as never),
    safetyStock: toQuantity(row.safetyStock as never),
    isActive: row.isActive,
    units: row.units.map((u) => ({ uom: u.uom, factor: Number(u.factor) })),
  };
}
