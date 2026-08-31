/**
 * Rota, standart maliyet ve raf veri erişimi.
 *
 * GERÇEKLEŞEN MALİYET İŞ EMRİNDEN OKUNUR, AYRI BİR TABLODAN DEĞİL.
 *
 * `get_work_order_cost` zaten iş emrinin gerçek maliyetini
 * hesaplıyor; sapma analizi onun üstüne kuruluyor. İkinci bir
 * "gerçekleşen maliyet" tablosu tutulsaydı, ikisi zamanla ayrışır ve
 * hangisinin doğru olduğu belirsizleşirdi.
 */

import { BusinessRuleError } from "../kernel/errors.js";
import type { TenantDb } from "./client.js";
import type { Operation, CostComponents } from "../modules/operations/routing.js";

export interface RoutingWithOperations {
  readonly code: string;
  readonly itemId: string;
  readonly name: string;
  readonly isActive: boolean;
  readonly operations: readonly Operation[];
}

export class RoutingRepository {
  readonly #db: TenantDb;

  constructor(db: TenantDb) {
    this.#db = db;
  }

  async createRouting(input: {
    code: string;
    itemId: string;
    name: string;
    operations: readonly Operation[];
    userId: string;
  }): Promise<{ code: string; operationCount: number }> {
    if (await this.#db.routing.findUnique({ where: { code: input.code } })) {
      throw new BusinessRuleError(`${input.code} kodlu rota zaten var.`, "routing_exists");
    }
    if (!(await this.#db.item.findUnique({ where: { code: input.itemId } }))) {
      throw new BusinessRuleError(
        `${input.itemId} kodlu malzeme yok; olmayan bir ürün için rota tanımlanamaz.`,
        "item_not_found",
      );
    }

    /*
     * İŞ MERKEZİ VAR MI KONTROL EDİLİR.
     *
     * Olmayan bir iş merkezine yazılan operasyon, kapasite yükünde
     * hiçbir yere düşmez ve rota "tanımlı" görünürken planlama onu
     * hiç görmez.
     */
    const merkezler = await this.#db.workCenter.findMany({
      where: { code: { in: [...new Set(input.operations.map((o) => o.workCenterId))] } },
      select: { code: true },
    });
    const bilinen = new Set(merkezler.map((m) => m.code));
    const eksik = [...new Set(input.operations.map((o) => o.workCenterId))].filter(
      (c) => !bilinen.has(c),
    );
    if (eksik.length > 0) {
      throw new BusinessRuleError(
        `Şu iş merkezleri tanımlı değil: ${eksik.join(", ")}. Olmayan bir merkeze ` +
          `yazılan operasyon kapasite yükünde hiçbir yere düşmez.`,
        "work_center_not_found",
      );
    }

    await this.#db.routing.create({
      data: {
        code: input.code,
        itemId: input.itemId,
        name: input.name,
        createdBy: input.userId,
        operations: {
          create: input.operations.map((o) => ({
            seq: o.seq,
            workCenterId: o.workCenterId,
            description: o.description,
            setupMinutes: o.setupMinutes,
            runMinutesPerUnit: o.runMinutesPerUnit,
          })),
        },
      },
    });
    return { code: input.code, operationCount: input.operations.length };
  }

  async routing(code: string): Promise<RoutingWithOperations | null> {
    const r = await this.#db.routing.findUnique({
      where: { code },
      include: { operations: { orderBy: { seq: "asc" } } },
    });
    if (!r) return null;
    return {
      code: r.code,
      itemId: r.itemId,
      name: r.name,
      isActive: r.isActive,
      operations: r.operations.map((o) => ({
        seq: o.seq,
        workCenterId: o.workCenterId,
        description: o.description,
        setupMinutes: Number(o.setupMinutes),
        runMinutesPerUnit: Number(o.runMinutesPerUnit),
      })),
    };
  }

  async routingsForItem(itemId: string): Promise<readonly RoutingWithOperations[]> {
    const rows = await this.#db.routing.findMany({
      where: { itemId, isActive: true },
      include: { operations: { orderBy: { seq: "asc" } } },
    });
    return rows.map((r) => ({
      code: r.code,
      itemId: r.itemId,
      name: r.name,
      isActive: r.isActive,
      operations: r.operations.map((o) => ({
        seq: o.seq,
        workCenterId: o.workCenterId,
        description: o.description,
        setupMinutes: Number(o.setupMinutes),
        runMinutesPerUnit: Number(o.runMinutesPerUnit),
      })),
    }));
  }

  async setStandardCost(input: {
    itemId: string;
    year: number;
    cost: CostComponents;
    currency: string;
    userId: string;
  }): Promise<{ created: boolean; previousTotal: number | null }> {
    if (!(await this.#db.item.findUnique({ where: { code: input.itemId } }))) {
      throw new BusinessRuleError(`${input.itemId} kodlu malzeme yok.`, "item_not_found");
    }
    const mevcut = await this.#db.standardCost.findUnique({
      where: { itemId_year: { itemId: input.itemId, year: input.year } },
    });

    const data = {
      materialCost: input.cost.material,
      laborCost: input.cost.labor,
      overheadCost: input.cost.overhead,
      currency: input.currency,
      setBy: input.userId,
    };

    if (mevcut) {
      await this.#db.standardCost.update({ where: { id: mevcut.id }, data });
      return {
        created: false,
        previousTotal:
          Number(mevcut.materialCost) + Number(mevcut.laborCost) + Number(mevcut.overheadCost),
      };
    }
    await this.#db.standardCost.create({
      data: { itemId: input.itemId, year: input.year, ...data },
    });
    return { created: true, previousTotal: null };
  }

  async standardCost(itemId: string, year: number): Promise<CostComponents | null> {
    const r = await this.#db.standardCost.findUnique({
      where: { itemId_year: { itemId, year } },
    });
    if (!r) return null;
    return {
      material: Number(r.materialCost),
      labor: Number(r.laborCost),
      overhead: Number(r.overheadCost),
    };
  }

  // ── Raf / göz ──

  async createBin(input: {
    locationCode: string;
    code: string;
    description: string | null;
    capacity: number | null;
    capacityUom: string | null;
  }): Promise<{ locationCode: string; code: string }> {
    const loc = await this.#db.location.findUnique({ where: { code: input.locationCode } });
    if (!loc) {
      throw new BusinessRuleError(
        `${input.locationCode} kodlu lokasyon yok.`,
        "location_not_found",
      );
    }
    const varMi = await this.#db.storageBin.findUnique({
      where: { locationId_code: { locationId: loc.id, code: input.code } },
    });
    if (varMi) {
      throw new BusinessRuleError(
        `${input.locationCode} lokasyonunda ${input.code} rafı zaten var.`,
        "bin_exists",
      );
    }
    await this.#db.storageBin.create({
      data: {
        locationId: loc.id,
        code: input.code,
        description: input.description,
        capacity: input.capacity,
        capacityUom: input.capacityUom,
      },
    });
    return { locationCode: input.locationCode, code: input.code };
  }

  /**
   * Bir lokasyondaki rafların doluluk durumu.
   *
   * MİKTAR STOK HAREKETLERİNDEN TOPLANIR. Rafta bir "mevcut miktar"
   * alanı tutulsaydı, düzeltme fişleri onu güncellemez ve raf sonsuza
   * kadar yanlış görünürdü.
   */
  async binContents(locationCode: string) {
    const loc = await this.#db.location.findUnique({
      where: { code: locationCode },
      include: { storageBins: { where: { isActive: true }, orderBy: { code: "asc" } } },
    });
    if (!loc) return null;

    const hareketler = await this.#db.stockMovement.groupBy({
      by: ["binCode", "itemId"],
      where: { locationId: loc.id },
      _sum: { quantity: true },
    });

    const raflar = loc.storageBins.map((b) => {
      const icerik = hareketler
        .filter((h) => h.binCode === b.code)
        .map((h) => ({ itemId: h.itemId, quantity: Number(h._sum.quantity ?? 0) }))
        .filter((x) => Math.abs(x.quantity) > 0.0001);
      const toplam = icerik.reduce((s, x) => s + x.quantity, 0);
      return {
        code: b.code,
        description: b.description,
        capacity: b.capacity === null ? null : Number(b.capacity),
        capacityUom: b.capacityUom,
        itemCount: icerik.length,
        totalQuantity: Math.round(toplam * 10000) / 10000,
        usedPercent:
          b.capacity === null || Number(b.capacity) === 0
            ? null
            : Math.round((toplam / Number(b.capacity)) * 1000) / 10,
        contents: icerik,
      };
    });

    /*
     * RAFI OLMAYAN STOK AYRICA SAYILIR.
     *
     * Raf yönetimine geçen bir depoda geçmiş hareketlerin rafı yok ve
     * onları bir rafa dağıtmak uydurma olurdu. Ne kadar olduğu
     * söyleniyor ki kullanıcı yerleştirsin.
     */
    const rafsiz = hareketler
      .filter((h) => h.binCode === null)
      .map((h) => ({ itemId: h.itemId, quantity: Number(h._sum.quantity ?? 0) }))
      .filter((x) => Math.abs(x.quantity) > 0.0001);

    return {
      locationCode: loc.code,
      locationName: loc.name,
      bins: raflar,
      unbinned: {
        itemCount: rafsiz.length,
        totalQuantity: Math.round(rafsiz.reduce((s, x) => s + x.quantity, 0) * 10000) / 10000,
        items: rafsiz,
      },
    };
  }
}
