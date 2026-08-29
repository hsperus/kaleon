/**
 * Cari içe aktarma — yazma tarafı.
 *
 * IDEMPOTENT: aynı dosyayı iki kez yüklemek mükerrer kayıt üretmez.
 * Kullanıcılar dosyayı iki kez yükler — bağlantı koptu sanır, "acaba oldu
 * mu" der, meslektaşı da yükler. Mükerrer cari kartı, ERP'de temizlenmesi
 * en zor kirliliktir.
 *
 * EŞLEŞTİRME SIRASI ÖNEMLİDİR:
 *   1. Vergi numarası — en güçlü anahtar, farklı unvanla yazılmış aynı
 *      firmayı yakalar ("Burçelik A.Ş." ve "BURCELIK AS").
 *   2. Cari kodu — dosyadaki kimlik.
 * Ters sırada yapılsaydı, aynı VKN'ye sahip iki farklı kodlu satır iki ayrı
 * kart açardı ve mükerrerlik tam da engellemek istediğimiz yerde oluşurdu.
 *
 * MEVCUT KAYIT EZİLMEZ, ZENGİNLEŞTİRİLİR. Dosyada boş olan bir alan,
 * veritabanındaki dolu alanın üstüne yazılmaz: kullanıcı eksik sütunlu bir
 * dosya yüklediğinde mevcut verisini kaybetmemelidir.
 */

import { normalizeName } from "../modules/master-data/normalize.js";
import type { PartnerImportRow } from "../modules/import/partners.js";
import type { TenantDb } from "./client.js";

export interface ImportOutcome {
  readonly created: number;
  readonly updated: number;
  readonly skipped: number;
  readonly failures: readonly { readonly code: string; readonly message: string }[];
}

export class PartnerImporter {
  readonly #db: TenantDb;

  constructor(db: TenantDb) {
    this.#db = db;
  }

  /**
   * Yazmadan önce: bu satırlar mevcut kayıtlarla nasıl kesişiyor?
   * Önizleme ekranı "142 yeni, 38 güncelleme" diyebilsin diye.
   */
  async classify(
    rows: readonly PartnerImportRow[],
  ): Promise<{ toCreate: readonly PartnerImportRow[]; toUpdate: readonly PartnerImportRow[] }> {
    const toCreate: PartnerImportRow[] = [];
    const toUpdate: PartnerImportRow[] = [];
    for (const row of rows) {
      const existing = await this.#find(row);
      (existing ? toUpdate : toCreate).push(row);
    }
    return { toCreate, toUpdate };
  }

  async commit(rows: readonly PartnerImportRow[]): Promise<ImportOutcome> {
    let created = 0;
    let updated = 0;
    let skipped = 0;
    const failures: { code: string; message: string }[] = [];

    for (const row of rows) {
      try {
        const existing = await this.#find(row);

        if (existing) {
          const changed = await this.#update(existing.id, row);
          if (changed) updated++;
          else skipped++;
          continue;
        }

        await this.#create(row);
        created++;
      } catch (e) {
        // BİR SATIRIN HATASI DOSYAYI DURDURMAZ. 4000 satırlık bir dosyanın
        // 3999'u yazılabiliyorsa yazılmalı; hatalı olan raporlanmalı.
        failures.push({ code: row.code, message: (e as Error).message });
      }
    }

    return { created, updated, skipped, failures };
  }

  /** Vergi numarası ÖNCE, cari kodu sonra. */
  async #find(row: PartnerImportRow): Promise<{ id: string } | null> {
    if (row.taxId) {
      const byTax = await this.#db.partner.findFirst({
        where: { taxIds: { some: { value: row.taxId.value } } },
        select: { id: true },
      });
      if (byTax) return byTax;
    }
    return this.#db.partner.findUnique({ where: { code: row.code }, select: { id: true } });
  }

  async #create(row: PartnerImportRow): Promise<void> {
    await this.#db.partner.create({
      data: {
        code: row.code,
        legalName: row.legalName,
        normalized: row.normalized,
        isSupplier: row.isSupplier,
        isCustomer: row.isCustomer,
        ...(row.taxId
          ? { taxIds: { create: [{ kind: row.taxId.kind, value: row.taxId.value }] } }
          : {}),
        ...(row.externalRef
          ? {
              externalRefs: {
                create: [{ system: row.externalRef.system, externalId: row.externalRef.externalId }],
              },
            }
          : {}),
      },
    });
  }

  /** Yalnızca DOLU alanlar yazılır; boş hücre mevcut veriyi silmez. */
  async #update(id: string, row: PartnerImportRow): Promise<boolean> {
    let changed = false;

    const current = await this.#db.partner.findUniqueOrThrow({
      where: { id },
      select: { legalName: true, isSupplier: true, isCustomer: true },
    });

    if (row.legalName && row.legalName !== current.legalName) {
      // Unvan değiştiyse ESKİSİ ALIAS OLARAK SAKLANIR: eski belgelerdeki
      // unvan hâlâ bu firmaya çözülebilmelidir.
      //
      // Kaynak `automatic` (0.93), `observed` (0.88) DEĞİL. Fark önemli:
      // "observed" bir tahmindir — entegratör verisinde görülmüş, henüz
      // doğrulanmamış bir isim. Buradaki ise KAYITLI BİR OLGU: bu cari
      // gerçekten bu isimle duruyordu ve müşterinin kendi ana verisinden
      // geldi. `observed` bırakılsaydı otomatik eşleşme eşiğinin (0.92)
      // altında kalır, eski unvanla gelen her fatura insan onayına düşerdi
      // ve "eski unvanı saklıyoruz" vaadi pratikte işe yaramazdı.
      await this.#db.partnerAlias.upsert({
        where: { partnerId_normalized: { partnerId: id, normalized: foldedOf(current.legalName) } },
        create: {
          partnerId: id,
          alias: current.legalName,
          normalized: foldedOf(current.legalName),
          source: "automatic",
          confidence: 0.93,
        },
        update: {},
      });
      await this.#db.partner.update({
        where: { id },
        data: { legalName: row.legalName, normalized: row.normalized },
      });
      changed = true;
    }

    // Tür bayrakları yalnızca EKLENİR: bir cari hem müşteri hem tedarikçi
    // olabilir ve dosyanın birinde eksik olması diğerini silmemeli.
    if ((row.isSupplier && !current.isSupplier) || (row.isCustomer && !current.isCustomer)) {
      await this.#db.partner.update({
        where: { id },
        data: {
          isSupplier: current.isSupplier || row.isSupplier,
          isCustomer: current.isCustomer || row.isCustomer,
        },
      });
      changed = true;
    }

    if (row.taxId) {
      const exists = await this.#db.partnerTaxId.findFirst({
        where: { partnerId: id, value: row.taxId.value },
        select: { id: true },
      });
      if (!exists) {
        await this.#db.partnerTaxId.create({
          data: { partnerId: id, kind: row.taxId.kind, value: row.taxId.value },
        });
        changed = true;
      }
    }

    if (row.externalRef) {
      const exists = await this.#db.partnerExternalRef.findUnique({
        where: {
          system_externalId: {
            system: row.externalRef.system,
            externalId: row.externalRef.externalId,
          },
        },
        select: { id: true },
      });
      if (!exists) {
        await this.#db.partnerExternalRef.create({
          data: {
            partnerId: id,
            system: row.externalRef.system,
            externalId: row.externalRef.externalId,
          },
        });
        changed = true;
      }
    }

    return changed;
  }
}

/**
 * Alias normalizasyonu, entity resolution ile AYNI fonksiyondan geçer.
 *
 * Burada ikinci bir normalizasyon yazmak cazipti ve sessiz bir hata olurdu:
 * alias, çözümleyicinin prefix aramasının BAKMADIĞI bir anahtarla yazılır,
 * arama onu hiç bulamaz ve "eski unvanı sakladık" iddiası boşa çıkardı.
 */
function foldedOf(name: string): string {
  return normalizeName(name).core;
}
