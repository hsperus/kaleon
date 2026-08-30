/**
 * Organizasyon yapısı deposu.
 *
 * `locations` tablosu vardı ama HİÇ OKUNMUYORDU: stok hareketlerinde
 * `location_id` çıplak bir metindi ve arkasında bir hiyerarşi yoktu.
 * Bunun pratik sonucu, çok tesisli bir müşterinin desteklenememesiydi —
 * "stok 4.200 adet" cümlesi hangi tesiste olduğu bilinmeden hiçbir işe
 * yaramaz.
 */

import type { TenantDb } from "./client.js";
import {
  assertHierarchy,
  descendantsOf,
  orphans,
  plantOf,
  OrganizationError,
  type LocationKind,
  type LocationNode,
} from "../modules/master-data/organization.js";

export class OrganizationRepository {
  readonly #db: TenantDb;

  constructor(db: TenantDb) {
    this.#db = db;
  }

  async all(): Promise<Map<string, LocationNode>> {
    const rows = await this.#db.location.findMany({ take: 2000 });
    const byId = new Map(rows.map((r) => [r.id, r]));
    return new Map(
      rows.map((r) => [
        r.code,
        {
          code: r.code,
          name: r.name,
          kind: r.kind as LocationKind,
          parentCode: r.parentId ? (byId.get(r.parentId)?.code ?? null) : null,
          isActive: r.isActive,
        },
      ]),
    );
  }

  async create(input: {
    code: string;
    name: string;
    kind: LocationKind;
    parentCode?: string | null;
  }): Promise<LocationNode> {
    const nodes = await this.all();
    if (nodes.has(input.code)) {
      throw new OrganizationError(`"${input.code}" kodlu lokasyon zaten var.`);
    }

    const parent = input.parentCode ? (nodes.get(input.parentCode) ?? null) : null;
    if (input.parentCode && !parent) {
      throw new OrganizationError(`Üst lokasyon bulunamadı: ${input.parentCode}`);
    }
    assertHierarchy(input.kind, parent);

    const parentRow = input.parentCode
      ? await this.#db.location.findUnique({ where: { code: input.parentCode } })
      : null;

    const row = await this.#db.location.create({
      data: {
        code: input.code,
        name: input.name,
        kind: input.kind,
        parentId: parentRow?.id ?? null,
      },
    });

    return {
      code: row.code,
      name: row.name,
      kind: row.kind as LocationKind,
      parentCode: input.parentCode ?? null,
      isActive: row.isActive,
    };
  }

  /** Bir lokasyonun ait olduğu tesis. */
  async plantOf(code: string): Promise<string | null> {
    return plantOf(code, await this.all());
  }

  /** Bir tesisin altındaki tüm depo ve depo yerleri. */
  async descendants(plantCode: string): Promise<readonly string[]> {
    const nodes = await this.all();
    const node = nodes.get(plantCode);
    if (!node) throw new OrganizationError(`Tesis bulunamadı: ${plantCode}`);
    if (node.kind !== "plant") {
      throw new OrganizationError(`"${plantCode}" bir tesis değil (${node.kind}).`);
    }
    return descendantsOf(plantCode, nodes);
  }

  /** Ağaç görünümü + bağlantısız lokasyonlar. */
  async tree() {
    const nodes = await this.all();
    const plants = [...nodes.values()].filter((n) => n.kind === "plant");
    return {
      plants: plants.map((p) => ({
        code: p.code,
        name: p.name,
        children: descendantsOf(p.code, nodes).map((c) => {
          const n = nodes.get(c)!;
          return { code: n.code, name: n.name, kind: n.kind, parentCode: n.parentCode };
        }),
      })),
      orphans: orphans(nodes),
      total: nodes.size,
    };
  }

  /**
   * Tesis bazında stok bakiyesi.
   *
   * Tek bir "stok 4.200" rakamı, iki tesisli bir işletmede karar
   * verdirmez: mal bir tesiste birikirken diğeri durabilir.
   */
  async stockByPlant(itemCode: string) {
    const nodes = await this.all();
    const movements = await this.#db.stockMovement.findMany({
      where: { itemId: itemCode },
      select: { locationId: true, quantity: true, direction: true },
      take: 20_000,
    });

    const byPlant = new Map<string, number>();
    let unassigned = 0;

    for (const m of movements) {
      const signed = m.direction * Number(m.quantity);
      const plant = nodes.has(m.locationId) ? plantOf(m.locationId, nodes) : null;
      if (plant === null) {
        // TESİSE BAĞLANAMAYAN HAREKET AYRI SAYILIR. Bir tesise
        // yazılsaydı o tesisin bakiyesi yanlış çıkardı.
        unassigned += signed;
        continue;
      }
      byPlant.set(plant, (byPlant.get(plant) ?? 0) + signed);
    }

    return {
      itemCode,
      byPlant: [...byPlant.entries()]
        .map(([plant, qty]) => ({
          plant,
          plantName: nodes.get(plant)?.name ?? plant,
          quantity: Math.round(qty * 10_000) / 10_000,
        }))
        .sort((a, b) => b.quantity - a.quantity),
      unassignedQuantity: Math.round(unassigned * 10_000) / 10_000,
      total: Math.round(([...byPlant.values()].reduce((s, n) => s + n, 0) + unassigned) * 10_000) / 10_000,
    };
  }
}
