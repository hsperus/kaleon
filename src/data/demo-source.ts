/**
 * Demo veri kaynağı.
 *
 * DEMO TENANT'I 114 TOOL'UN 24'ÜNÜ GÖSTERİYORDU. Demo, bellek
 * kaynağıyla kurulduğu için yalnızca o kaynağa bağlı modüller
 * yükleniyordu; muhasebe, MRP, e-Fatura, bakım, İK — ürünün asıl
 * gövdesi — demoda hiç yoktu. Ürünü ilk kez gören kişi, olanın beşte
 * birini görüyordu.
 *
 * ÇÖZÜM AYRIMI DOĞRU YERE KOYMAK. `DataSource` yalnızca DIŞ
 * KANALLARDIR: banka, sevkiyat, WIP, mesai — bunların gerçek
 * entegrasyon adaptörü henüz yok ve gerçek tenant'ta boş dönüyorlar.
 * Demoda bunlar bellekten gelmeli. Geri kalan her şey (cari, sipariş,
 * fatura, stok, muhasebe) zaten Postgres'te yaşıyor ve demo şemasında
 * da yaşayabilir.
 *
 * CARİ ADAYLARI POSTGRES'TEN OKUNUR. Bellekten okunsaydı demo ikiye
 * bölünürdü: `resolve_partner` bir cari listesi, `get_invoice_document`
 * başka bir dünyayı gösterirdi. Kullanıcı cari eklerdi ve arattığında
 * bulamazdı — "ekledim ama yok" hâli, tool'un hiç olmamasından da
 * kötüdür.
 */

import type {
  BankBalance,
  DataSource,
  OvertimeRecord,
  PartnerCandidateRow,
  PartnerHint,
  ShipmentRisk,
  WipSnapshot,
  WithFreshness,
} from "./port.js";

export class DemoDataSource implements DataSource {
  readonly #channels: DataSource;
  readonly #db: DataSource;

  /**
   * @param channels Adaptörü olmayan dış kanallar (bellek gösteri kümesi).
   * @param db Tenant şemasına bağlı gerçek kaynak.
   */
  constructor(channels: DataSource, db: DataSource) {
    this.#channels = channels;
    this.#db = db;
  }

  wipSnapshot(tenantId: string): Promise<WithFreshness<WipSnapshot>> {
    return this.#channels.wipSnapshot(tenantId);
  }

  shipmentRisks(tenantId: string, week: number): Promise<WithFreshness<readonly ShipmentRisk[]>> {
    return this.#channels.shipmentRisks(tenantId, week);
  }

  bankBalances(
    tenantId: string,
    currency: string | null,
  ): Promise<WithFreshness<readonly BankBalance[]>> {
    return this.#channels.bankBalances(tenantId, currency);
  }

  overtime(
    tenantId: string,
    args: { employeeQuery: string | null; department: string | null; period: string },
  ): Promise<WithFreshness<readonly OvertimeRecord[]>> {
    return this.#channels.overtime(tenantId, args);
  }

  /** Cariler gerçek şemadan — demo ile veri tek dünyada kalsın. */
  partnerCandidates(
    tenantId: string,
    hint: PartnerHint,
  ): Promise<WithFreshness<readonly PartnerCandidateRow[]>> {
    return this.#db.partnerCandidates(tenantId, hint);
  }
}
