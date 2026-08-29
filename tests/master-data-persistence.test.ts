/**
 * Entity resolution — gerçek Postgres'e karşı uçtan uca.
 *
 * Bellek testleri motorun DOĞRU SKORLADIĞINI kanıtlar. Bu dosya farklı bir
 * şey kanıtlar: **doğru aday veritabanından geliyor mu?** Mükemmel bir
 * skorlayıcı, aday kümesine hiç girmemiş bir kaydı bulamaz. ERP'lerde cari
 * mükerrerliğinin asıl sebebi de budur — eşleştirme mantığı değil, ön
 * elemenin kaçırması.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient as SharedPrisma } from "../src/db/generated/shared/index.js";
import { PrismaClient as TenantPrisma } from "../src/db/generated/tenant/index.js";
import { dropTenantSchema, provisionTenantSchema } from "../src/db/provision.js";
import { urlForSchema } from "../src/db/client.js";
import { PrismaDataSource } from "../src/db/master-data-source.js";
import { normalizeName } from "../src/modules/master-data/normalize.js";
import { resolvePartner } from "../src/modules/master-data/resolver.js";

const SHARED_URL = process.env["SHARED_DATABASE_URL"];
const TENANT_URL = process.env["TENANT_DATABASE_URL"];
const enabled = Boolean(SHARED_URL && TENANT_URL);

const SCHEMA = "tenant_it_md";
const T = SCHEMA;

describe.skipIf(!enabled)("Entity resolution kalıcılığı", () => {
  let shared: SharedPrisma;
  let db: TenantPrisma;
  let source: PrismaDataSource;

  beforeAll(async () => {
    shared = new SharedPrisma();
    await dropTenantSchema(shared, SCHEMA);
    await provisionTenantSchema(shared, SCHEMA);
    db = new TenantPrisma({ datasources: { db: { url: urlForSchema(TENANT_URL!, SCHEMA) } } });
    source = new PrismaDataSource(db);
  }, 60_000);

  afterAll(async () => {
    await db?.$disconnect();
    if (shared) {
      await dropTenantSchema(shared, SCHEMA);
      await shared.$disconnect();
    }
  });

  beforeEach(async () => {
    await db.partnerAlias.deleteMany();
    await db.partnerTaxId.deleteMany();
    await db.partnerExternalRef.deleteMany();
    await db.partner.deleteMany();

    // Burçelik — VKN'si, aliası ve entegratör kodu olan tam kayıt.
    await db.partner.create({
      data: {
        code: "C-0001",
        legalName: "Burçelik Bursa Çelik Döküm Sanayi A.Ş.",
        normalized: normalizeName("Burçelik Bursa Çelik Döküm Sanayi A.Ş.").core,
        isSupplier: true,
        taxIds: { create: [{ kind: "vkn", value: "1234567890" }] },
        externalRefs: { create: [{ system: "uyumsoft", externalId: "SUP-00432" }] },
        aliases: {
          create: [
            {
              alias: "BURÇELİK A.Ş.",
              normalized: normalizeName("BURÇELİK A.Ş.").core,
              source: "confirmed",
              confidence: 0.96,
            },
          ],
        },
      },
    });

    // Gürateş — ayırt edici kelimesi farklı, karışmamalı.
    await db.partner.create({
      data: {
        code: "C-0002",
        legalName: "Gürateş Metal Sanayi Ltd. Şti.",
        normalized: normalizeName("Gürateş Metal Sanayi Ltd. Şti.").core,
        isSupplier: true,
        taxIds: { create: [{ kind: "vkn", value: "4444444444" }] },
      },
    });
  });

  // ─────────────────── ön eleme kanalları ───────────────────

  it("VKN kanalı: yalnızca numarayla doğru cari bulunur", async () => {
    const { rows } = await source.partnerCandidates(T, { name: null, taxId: "1234567890" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.legalName).toContain("Burçelik");
    expect(rows[0]!.taxIds[0]).toMatchObject({ kind: "vkn", valid: true });
  });

  it("VKN boşluk/nokta ile yazılsa da bulunur", async () => {
    const { rows } = await source.partnerCandidates(T, { name: null, taxId: "123 456 78 90" });
    expect(rows).toHaveLength(1);
  });

  it("ENTEGRATÖR KODU KANALI: sadece cari koduyla gelen belge adayı bulur", async () => {
    // Bu kanal olmadan e-faturaların çoğu "yeni firma" olarak açılırdı.
    const { rows } = await source.partnerCandidates(T, {
      name: null,
      taxId: null,
      externalRef: { system: "uyumsoft", externalId: "SUP-00432" },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.legalName).toContain("Burçelik");
  });

  it("bilinmeyen entegratör kodu aday üretmez", async () => {
    const { rows } = await source.partnerCandidates(T, {
      name: null,
      taxId: null,
      externalRef: { system: "uyumsoft", externalId: "SUP-99999" },
    });
    expect(rows).toEqual([]);
  });

  it("ad kanalı: TÜRKÇE BÜYÜK HARF yazımı da aynı kaydı bulur", async () => {
    // "BURÇELİK".toLowerCase() görünmez bir birleşen nokta bırakır; veritabanı
    // araması normalize edilmiş sütun üzerinden gittiği için etkilenmez.
    const { rows } = await source.partnerCandidates(T, { name: "BURÇELİK A.Ş.", taxId: null });
    expect(rows.map((r) => r.legalName)).toContain("Burçelik Bursa Çelik Döküm Sanayi A.Ş.");
  });

  it("ad kanalı alias tablosunu da tarar", async () => {
    await db.partner.create({
      data: {
        code: "C-0003",
        legalName: "Kuzey Döküm Sanayi A.Ş.",
        normalized: normalizeName("Kuzey Döküm Sanayi A.Ş.").core,
        aliases: {
          create: [
            {
              alias: "Nortcast",
              normalized: normalizeName("Nortcast").core,
              source: "confirmed",
              confidence: 0.96,
            },
          ],
        },
      },
    });
    // "Nortcast" partner adında hiç geçmiyor; yalnızca alias'ta var.
    const { rows } = await source.partnerCandidates(T, { name: "Nortcast", taxId: null });
    expect(rows.map((r) => r.legalName)).toContain("Kuzey Döküm Sanayi A.Ş.");
  });

  it("PREFİX ARAMASININ SINIRI: ilk kelimedeki yazım hatası kaçırılır", async () => {
    // Bu bir hata değil, BİLİNEN ve yazılı bir sınır. Prefix indeksi
    // "burcelik" ile başlamayan hiçbir kaydı getirmez. Kesin çözüm pg_trgm
    // üzerine GIN indeksi; eklenti kurulumu gerektirdiği için ertelendi.
    // Test bunu iddia ediyor ki eklenti geldiğinde KIRILSIN ve güncellensin.
    const { rows } = await source.partnerCandidates(T, { name: "Burçlik Bursa", taxId: null });
    expect(rows).toEqual([]);
  });

  it("aday kümesi şişmez — ön eleme gerçekten eliyor", async () => {
    const { rows } = await source.partnerCandidates(T, { name: "Zeytinburnu Tekstil", taxId: null });
    expect(rows).toEqual([]);
  });

  // ─────────────────── motor + veritabanı birlikte ───────────────────

  it("uçtan uca: VKN ile otomatik eşleşme", async () => {
    const { rows } = await source.partnerCandidates(T, {
      name: "Burcelik",
      taxId: "1234567890",
    });
    const result = resolvePartner({ name: "Burcelik", taxId: "1234567890", externalRef: null }, rows);
    expect(result.status).toBe("resolved");
    if (result.status === "resolved") {
      expect(result.match.legalName).toContain("Burçelik");
      expect(result.match.confidence).toBeGreaterThanOrEqual(0.95);
    }
  });

  it("uçtan uca: yalnızca entegratör koduyla eşleşme", async () => {
    const hint = {
      name: null,
      taxId: null,
      externalRef: { system: "uyumsoft", externalId: "SUP-00432" },
    };
    const { rows } = await source.partnerCandidates(T, hint);
    const result = resolvePartner(
      { name: null, taxId: null, externalRef: hint.externalRef },
      rows,
    );
    expect(result.status).toBe("resolved");
    if (result.status === "resolved") {
      expect(result.match.legalName).toContain("Burçelik");
    }
  });

  it("uçtan uca: bilinmeyen firma YENİ olarak işaretlenir, uydurulmaz", async () => {
    const { rows } = await source.partnerCandidates(T, {
      name: "Anadolu Kalıp Makina Ltd.",
      taxId: null,
    });
    const result = resolvePartner(
      { name: "Anadolu Kalıp Makina Ltd.", taxId: null, externalRef: null },
      rows,
    );
    expect(result.status).toBe("not_found");
  });

  it("BAŞKA TENANT'IN CARİSİ GÖRÜNMEZ", async () => {
    // İzolasyon bağlantıda: her tenant client'ı kendi şemasına sabitlenir.
    // Aynı VKN iki şemada da olsa, sorgu yalnızca kendi şemasını görür.
    const other = "tenant_it_md_2";
    await dropTenantSchema(shared, other);
    await provisionTenantSchema(shared, other);
    const otherDb = new TenantPrisma({
      datasources: { db: { url: urlForSchema(TENANT_URL!, other) } },
    });
    try {
      await otherDb.partner.create({
        data: {
          code: "C-0001",
          legalName: "Başka Şirketin Carisi A.Ş.",
          normalized: normalizeName("Başka Şirketin Carisi A.Ş.").core,
          taxIds: { create: [{ kind: "vkn", value: "1234567890" }] },
        },
      });

      // Aynı VKN her iki şemada da var; her kaynak KENDİ kaydını görür.
      const mine = await source.partnerCandidates(T, { name: null, taxId: "1234567890" });
      const theirs = await new PrismaDataSource(otherDb).partnerCandidates(other, {
        name: null,
        taxId: "1234567890",
      });

      expect(mine.rows).toHaveLength(1);
      expect(theirs.rows).toHaveLength(1);
      expect(mine.rows[0]!.legalName).toContain("Burçelik");
      expect(theirs.rows[0]!.legalName).toContain("Başka Şirketin");
    } finally {
      await otherDb.$disconnect();
      await dropTenantSchema(shared, other);
    }
  }, 60_000);

  it("BAĞLANMAYAN KANALLAR BOŞ DÖNER — uydurma veri yok", async () => {
    // Sevkiyat/WIP için tenant şemasında henüz tablo yok.
    expect((await source.shipmentRisks()).rows).toEqual([]);
    expect((await source.wipSnapshot()).rows.stations).toEqual([]);
  });
});

/**
 * Banka bakiyeleri.
 *
 * Buradaki testlerin çoğu "bakiye doğru mu" değil, "hangi bakiye" sorusunu
 * sorar. Bir ERP'de en pahalı hata, dünkü bakiyeyi bugünkü sanmaktır.
 */
describe.skipIf(!enabled)("Banka bakiyeleri", () => {
  let shared: SharedPrisma;
  let db: TenantPrisma;
  let source: PrismaDataSource;

  const SCHEMA_B = "tenant_it_bank";

  beforeAll(async () => {
    shared = new SharedPrisma();
    await dropTenantSchema(shared, SCHEMA_B);
    await provisionTenantSchema(shared, SCHEMA_B);
    db = new TenantPrisma({ datasources: { db: { url: urlForSchema(TENANT_URL!, SCHEMA_B) } } });
    source = new PrismaDataSource(db);
  }, 60_000);

  afterAll(async () => {
    await db?.$disconnect();
    if (shared) {
      await dropTenantSchema(shared, SCHEMA_B);
      await shared.$disconnect();
    }
  });

  beforeEach(async () => {
    await db.bankBalanceSnapshot.deleteMany();
    await db.bankAccount.deleteMany();
  });

  async function account(bank: string, currency: string, externalId: string) {
    return db.bankAccount.create({ data: { bank, currency, externalId } });
  }

  it("güncel bakiye = en son anlık görüntü", async () => {
    const acc = await account("Garanti BBVA", "TRY", "ACC-1");
    await db.bankBalanceSnapshot.createMany({
      data: [
        { accountId: acc.id, asOf: new Date("2026-05-16T06:00:00Z"), available: 5_000_000, blocked: 0 },
        { accountId: acc.id, asOf: new Date("2026-05-16T18:00:00Z"), available: 12_400_000, blocked: 0 },
        { accountId: acc.id, asOf: new Date("2026-05-16T12:00:00Z"), available: 9_000_000, blocked: 0 },
      ],
    });
    const { rows } = await source.bankBalances(SCHEMA_B, null);
    expect(rows).toEqual([
      { bank: "Garanti BBVA", currency: "TRY", available: 12_400_000, blocked: 0 },
    ]);
  });

  it("GEÇMİŞ SİLİNMEZ — dünkü bakiye tabloda durur", async () => {
    const acc = await account("Garanti BBVA", "TRY", "ACC-1");
    await db.bankBalanceSnapshot.createMany({
      data: [
        { accountId: acc.id, asOf: new Date("2026-05-15T18:00:00Z"), available: 3_000_000, blocked: 0 },
        { accountId: acc.id, asOf: new Date("2026-05-16T18:00:00Z"), available: 12_400_000, blocked: 0 },
      ],
    });
    expect(await db.bankBalanceSnapshot.count()).toBe(2);
  });

  it("aynı an iki kez yazılmaz — senkronizasyon tekrarı idempotent", async () => {
    const acc = await account("Garanti BBVA", "TRY", "ACC-1");
    const at = new Date("2026-05-16T18:00:00Z");
    await db.bankBalanceSnapshot.create({
      data: { accountId: acc.id, asOf: at, available: 12_400_000, blocked: 0 },
    });
    await expect(
      db.bankBalanceSnapshot.create({
        data: { accountId: acc.id, asOf: at, available: 999, blocked: 0 },
      }),
    ).rejects.toThrow();
  });

  it("TAZELİK EN ESKİ HESAPTAN GELİR", async () => {
    // İki banka beş dakika önce, biri dün senkronize olduysa doğru cevap "dün".
    const a = await account("Garanti BBVA", "TRY", "ACC-1");
    const b = await account("İş Bankası", "TRY", "ACC-2");
    await db.bankBalanceSnapshot.createMany({
      data: [
        { accountId: a.id, asOf: new Date("2026-05-16T18:00:00Z"), available: 1, blocked: 0 },
        { accountId: b.id, asOf: new Date("2026-05-15T09:00:00Z"), available: 2, blocked: 0 },
      ],
    });
    const { freshness } = await source.bankBalances(SCHEMA_B, null);
    expect(freshness.syncedAt).toBe("2026-05-15T09:00:00.000Z");
  });

  it("bakiyesi hiç gelmemiş hesap SIFIR olarak gösterilmez", async () => {
    // Sıfır bir iddiadır; "bilmiyorum" ile aynı şey değildir.
    await account("Yapı Kredi", "EUR", "ACC-3");
    const { rows } = await source.bankBalances(SCHEMA_B, null);
    expect(rows).toEqual([]);
  });

  it("para birimi filtresi çalışır", async () => {
    const a = await account("Garanti BBVA", "TRY", "ACC-1");
    const b = await account("Garanti BBVA", "EUR", "ACC-2");
    await db.bankBalanceSnapshot.createMany({
      data: [
        { accountId: a.id, asOf: new Date("2026-05-16T18:00:00Z"), available: 12_400_000, blocked: 0 },
        { accountId: b.id, asOf: new Date("2026-05-16T18:00:00Z"), available: 198_400, blocked: 0 },
      ],
    });
    const eur = await source.bankBalances(SCHEMA_B, "EUR");
    expect(eur.rows).toEqual([
      { bank: "Garanti BBVA", currency: "EUR", available: 198_400, blocked: 0 },
    ]);
  });

  it("blokeli tutar ayrı taşınır, kullanılabilire karışmaz", async () => {
    const a = await account("İş Bankası", "EUR", "ACC-9");
    await db.bankBalanceSnapshot.create({
      data: {
        accountId: a.id,
        asOf: new Date("2026-05-16T18:00:00Z"),
        available: 126_050,
        blocked: 16_650,
      },
    });
    const { rows } = await source.bankBalances(SCHEMA_B, null);
    expect(rows[0]).toMatchObject({ available: 126_050, blocked: 16_650 });
  });

  it("pasif hesap listelenmez", async () => {
    const a = await account("Kapanmış Banka", "TRY", "ACC-X");
    await db.bankBalanceSnapshot.create({
      data: { accountId: a.id, asOf: new Date("2026-05-16T18:00:00Z"), available: 5, blocked: 0 },
    });
    await db.bankAccount.update({ where: { id: a.id }, data: { isActive: false } });
    expect((await source.bankBalances(SCHEMA_B, null)).rows).toEqual([]);
  });
});
