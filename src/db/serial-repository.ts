/**
 * Seri numarası deposu.
 *
 * BİR SERİ AYNI ANDA TEK YERDE OLUR. Durumu (stokta / sevk edildi /
 * serviste / hurda) tek bir alan tutar; iki yerde birden görünmesi
 * envanterin iki kez sayılması demektir.
 */

import type { TenantDb } from "./client.js";
import {
  assertTransition,
  normalizeSerial,
  warrantyStatus,
  SerialError,
  type SerialState,
} from "../modules/inventory/serial.js";

export class SerialRepository {
  readonly #db: TenantDb;

  constructor(db: TenantDb) {
    this.#db = db;
  }

  async create(input: {
    itemCode: string;
    serial: string;
    batchId?: string | null;
    producedAt?: Date | null;
    warrantyMonths?: number | null;
  }): Promise<{ serial: string }> {
    const item = await this.#db.item.findUnique({
      where: { code: input.itemCode },
      select: { serialManaged: true },
    });
    if (!item) throw new SerialError(`Malzeme bulunamadı: ${input.itemCode}`);

    // SERİ TAKİPSİZ MALZEMEYE SERİ AÇILMAZ. Açılsaydı bazı ürünler
    // serili bazıları serisiz olurdu ve izleme yarım kalırdı — yarım
    // izleme, izleme olmamasından tehlikelidir çünkü tam sanılır.
    if (!item.serialManaged) {
      throw new SerialError(
        `"${input.itemCode}" seri takipli değil; seri numarası açılamaz. ` +
          `Gerekiyorsa önce malzeme kartında seri takibi açılmalıdır.`,
      );
    }

    const serial = normalizeSerial(input.serial);
    const existing = await this.#db.serialNumber.findUnique({
      where: { itemId_serial: { itemId: input.itemCode, serial } },
    });
    if (existing) {
      throw new SerialError(
        `"${input.itemCode}" için "${serial}" seri numarası zaten var. Seri tekrar ` +
          `kullanılamaz; iki ürünün geçmişi tek kayıtta birleşirdi.`,
      );
    }

    await this.#db.serialNumber.create({
      data: {
        itemId: input.itemCode,
        serial,
        state: "stokta",
        batchId: input.batchId ?? null,
        producedAt: input.producedAt ?? null,
        warrantyMonths: input.warrantyMonths ?? null,
      },
    });
    return { serial };
  }

  async byNumber(itemCode: string, serial: string) {
    const row = await this.#db.serialNumber.findUnique({
      where: { itemId_serial: { itemId: itemCode, serial: normalizeSerial(serial) } },
    });
    return row;
  }

  /** Seriyi sevk eder: durumu ve müşterisi işlenir, garanti işlemeye başlar. */
  async ship(input: {
    itemCode: string;
    serial: string;
    partnerId: string;
    deliveryId: string;
    shippedAt: Date;
  }): Promise<void> {
    const row = await this.byNumber(input.itemCode, input.serial);
    if (!row) {
      throw new SerialError(
        `"${input.itemCode}" için "${input.serial}" seri numarası kayıtlı değil. ` +
          `Kayıtsız seri sevk edilemez; garanti ve izleme zinciri o noktada kopar.`,
      );
    }
    assertTransition(row.state as SerialState, "sevk_edildi");

    await this.#db.serialNumber.update({
      where: { id: row.id },
      data: {
        state: "sevk_edildi",
        partnerId: input.partnerId,
        deliveryId: input.deliveryId,
        shippedAt: input.shippedAt,
      },
    });
  }

  async setState(
    itemCode: string,
    serial: string,
    state: SerialState,
    note?: string | null,
  ): Promise<void> {
    const row = await this.byNumber(itemCode, serial);
    if (!row) throw new SerialError(`Seri bulunamadı: ${itemCode} / ${serial}`);
    assertTransition(row.state as SerialState, state);
    await this.#db.serialNumber.update({
      where: { id: row.id },
      data: { state, ...(note !== undefined ? { note } : {}) },
    });
  }

  /**
   * Bir serinin tam geçmişi: üretim, parti, sevkiyat, müşteri, garanti.
   *
   * Müşteri "benim aldığım cihaz" dediğinde tek sorgu ile cevap
   * verilebilmelidir; beş ayrı yere bakmak, servisi yavaşlatır.
   */
  async trace(itemCode: string, serial: string, on: Date) {
    const row = await this.byNumber(itemCode, serial);
    if (!row) return null;

    const [delivery, partner, batch] = await Promise.all([
      row.deliveryId
        ? this.#db.delivery.findUnique({
            where: { id: row.deliveryId },
            select: { documentNo: true, shippedAt: true, salesOrder: { select: { orderNo: true } } },
          })
        : null,
      row.partnerId
        ? this.#db.partner.findFirst({
            where: { id: row.partnerId },
            select: { legalName: true, code: true },
          })
        : null,
      row.batchId
        ? this.#db.batch.findFirst({
            where: { itemId: itemCode, batchNo: row.batchId },
            select: { batchNo: true, producedAt: true, origin: true },
          })
        : null,
    ]);

    const warranty = warrantyStatus({
      shippedAt: row.shippedAt,
      warrantyMonths: row.warrantyMonths,
      on,
    });

    return {
      itemCode,
      serial: row.serial,
      state: row.state,
      producedAt: row.producedAt?.toISOString().slice(0, 10) ?? null,
      batch: batch ? { batchNo: batch.batchNo, origin: batch.origin } : null,
      shippedAt: row.shippedAt?.toISOString().slice(0, 10) ?? null,
      deliveryNo: delivery?.documentNo ?? null,
      orderNo: delivery?.salesOrder.orderNo ?? null,
      customer: partner ? { code: partner.code, name: partner.legalName } : null,
      warranty,
      note: row.note,
    };
  }

  /** Bir müşteriye giden tüm seriler — servis çağrısında ilk bakılacak yer. */
  async byPartner(partnerId: string, limit = 100) {
    const rows = await this.#db.serialNumber.findMany({
      where: { partnerId },
      orderBy: { shippedAt: "desc" },
      take: limit,
    });
    return rows.map((r) => ({
      itemCode: r.itemId,
      serial: r.serial,
      state: r.state,
      shippedAt: r.shippedAt?.toISOString().slice(0, 10) ?? null,
      warrantyMonths: r.warrantyMonths,
    }));
  }

  /** Garantisi biten/bitecek seriler. */
  async warrantyExpiring(on: Date, withinDays: number, limit = 100) {
    const rows = await this.#db.serialNumber.findMany({
      where: { state: "sevk_edildi", shippedAt: { not: null }, warrantyMonths: { not: null } },
      take: 2000,
    });

    const out = rows
      .map((r) => ({
        itemCode: r.itemId,
        serial: r.serial,
        customer: r.partnerId,
        ...warrantyStatus({ shippedAt: r.shippedAt, warrantyMonths: r.warrantyMonths, on }),
      }))
      .filter((r) => r.daysRemaining !== null && r.daysRemaining <= withinDays)
      .sort((a, b) => (a.daysRemaining ?? 0) - (b.daysRemaining ?? 0))
      .slice(0, limit);

    return out;
  }
}
