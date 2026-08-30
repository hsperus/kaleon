/**
 * Ana veri değişiklik belgesi — gerçek Postgres'e karşı.
 *
 * Tek iddia: HİÇBİR KOD YOLU İZ BIRAKMADAN ANA VERİYİ DEĞİŞTİREMEZ.
 * Kayıt uygulamada değil veritabanı tetikleyicisiyle üretiliyor; bu yüzden
 * doğrudan SQL ile yapılan bir düzeltme bile iz bırakır — ama aktörü
 * bilinmez ve öyle görünür.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient as SharedPrisma } from "../src/db/generated/shared/index.js";
import { PrismaClient as TenantPrisma } from "../src/db/generated/tenant/index.js";
import { dropTenantSchema, provisionTenantSchema } from "../src/db/provision.js";
import { urlForSchema } from "../src/db/client.js";
import { ChangeLogRepository } from "../src/db/change-log.js";
import { PrismaItemRepository } from "../src/db/item-repository.js";
import { ItemImporter } from "../src/db/importers.js";
import { normalizeName } from "../src/modules/master-data/normalize.js";

const SHARED_URL = process.env["SHARED_DATABASE_URL"];
const TENANT_URL = process.env["TENANT_DATABASE_URL"];
const enabled = Boolean(SHARED_URL && TENANT_URL);
const SCHEMA = "tenant_it_change";
const AYSE = "00000000-0000-0000-0000-0000000000a5";

describe.skipIf(!enabled)("ana veri değişiklik belgesi", () => {
  let shared: SharedPrisma;
  let db: TenantPrisma;
  let repo: ChangeLogRepository;
  let items: PrismaItemRepository;

  beforeAll(async () => {
    shared = new SharedPrisma();
    await dropTenantSchema(shared, SCHEMA);
    await provisionTenantSchema(shared, SCHEMA);
    db = new TenantPrisma({ datasources: { db: { url: urlForSchema(TENANT_URL!, SCHEMA) } } });
    repo = new ChangeLogRepository(db);
    items = new PrismaItemRepository(db);
  }, 60_000);

  afterAll(async () => {
    await db?.$disconnect();
    if (shared) {
      await dropTenantSchema(shared, SCHEMA);
      await shared.$disconnect();
    }
  });

  beforeEach(async () => {
    // SİLME DE BİR DEĞİŞİKLİKTİR ve tetikleyici onu da yazar. Bu yüzden
    // önce kayıtlar silinir, SONRA log temizlenir; ters sırada yapılırsa
    // her testin başında aktörü bilinmeyen silme kayıtları kalır.
    await db.itemUnit.deleteMany();
    await db.item.deleteMany();
    await db.partner.deleteMany();
    await db.$executeRawUnsafe(`ALTER TABLE "master_data_changes" DISABLE TRIGGER USER`);
    await db.$executeRawUnsafe(`DELETE FROM "master_data_changes"`);
    await db.$executeRawUnsafe(`ALTER TABLE "master_data_changes" ENABLE TRIGGER USER`);
  });

  describe("yakalama", () => {
    it("KART AÇILIŞI TEK SATIRLA KAYDEDİLİR", async () => {
      await items.create(
        { code: "M-1", name: "Test", type: "hammadde", baseUom: "kg" },
        [],
        AYSE,
      );
      const h = await repo.historyOf("items", "M-1");
      expect(h).toHaveLength(1);
      expect(h[0]).toMatchObject({ operation: "insert", field: "*", changedBy: AYSE });
    });

    it("HER DEĞİŞEN ALAN AYRI SATIR — 'kayıt değişti' yetmez", async () => {
      await items.create({ code: "M-1", name: "Test", type: "hammadde", baseUom: "kg" }, [], AYSE);
      await db.item.update({
        where: { code: "M-1" },
        data: { name: "Test 2", leadTimeDays: 21, batchManaged: true },
      });

      const h = await repo.historyOf("items", "M-1");
      const updates = h.filter((c) => c.operation === "update");
      expect(updates.map((u) => u.field).sort()).toEqual([
        "batch_managed",
        "lead_time_days",
        "name",
      ]);
      const name = updates.find((u) => u.field === "name")!;
      expect(name.oldValue).toBe("Test");
      expect(name.newValue).toBe("Test 2");
    });

    it("NULL'DAN DEĞERE GEÇİŞ DE DEĞİŞİKLİKTİR", async () => {
      // `<>` ile karşılaştırılsaydı bu sessizce atlanırdı.
      await items.create({ code: "M-1", name: "Test", type: "hammadde", baseUom: "kg" }, [], AYSE);
      await db.item.update({ where: { code: "M-1" }, data: { shelfLifeDays: 90 } });
      const h = await repo.fieldHistory("items", "M-1", "shelf_life_days");
      expect(h[0]).toMatchObject({ oldValue: null, newValue: "90" });
    });

    it("DEĞERDEN NULL'A GEÇİŞ DE YAKALANIR", async () => {
      await items.create({ code: "M-1", name: "Test", type: "hammadde", baseUom: "kg" }, [], AYSE);
      await db.item.update({ where: { code: "M-1" }, data: { leadTimeDays: 10 } });
      await db.item.update({ where: { code: "M-1" }, data: { leadTimeDays: null } });
      const h = await repo.fieldHistory("items", "M-1", "lead_time_days");
      expect(h[0]).toMatchObject({ oldValue: "10", newValue: null });
    });

    it("GÜRÜLTÜ ALANLARI KAYDEDİLMEZ", async () => {
      // `updated_at` her güncellemede değişir; kaydedilseydi gerçek
      // değişiklikleri görünmez kılardı.
      await items.create({ code: "M-1", name: "Test", type: "hammadde", baseUom: "kg" }, [], AYSE);
      await db.item.update({ where: { code: "M-1" }, data: { name: "Yeni" } });
      const fields = (await repo.historyOf("items", "M-1")).map((c) => c.field);
      expect(fields).not.toContain("updated_at");
      expect(fields).not.toContain("normalized");
    });

    it("değişmeyen alan için kayıt üretilmez", async () => {
      await items.create({ code: "M-1", name: "Test", type: "hammadde", baseUom: "kg" }, [], AYSE);
      await db.item.update({ where: { code: "M-1" }, data: { name: "Test" } });
      expect(
        (await repo.historyOf("items", "M-1")).filter((c) => c.operation === "update"),
      ).toEqual([]);
    });

    it("cari ve personel de izlenir", async () => {
      await db.partner.create({
        data: {
          code: "C-1",
          legalName: "Test A.Ş.",
          normalized: normalizeName("Test A.Ş.").core,
          isSupplier: true,
        },
      });
      await db.partner.update({ where: { code: "C-1" }, data: { legalName: "Test Ltd." } });
      const h = await repo.fieldHistory("partners", "C-1", "legal_name");
      expect(h[0]).toMatchObject({ oldValue: "Test A.Ş.", newValue: "Test Ltd." });
    });
  });

  describe("aktör", () => {
    it("İÇE AKTARMADA DOSYAYI YÜKLEYEN KAYDEDİLİR", async () => {
      const importer = new ItemImporter(db);
      await importer.commit(
        [
          {
            code: "M-9",
            name: "İçe aktarılan",
            normalized: "ice aktarilan",
            type: "hammadde",
            baseUom: "kg",
            procurementType: "satin_alma",
            batchManaged: false,
            leadTimeDays: null,
            altUom: null,
          },
        ] as never,
        AYSE,
      );
      const h = await repo.historyOf("items", "M-9");
      expect(h[0]!.changedBy).toBe(AYSE);
    });

    it("DOĞRUDAN SQL DE İZ BIRAKIR — ama aktörü BİLİNMEZ", async () => {
      await items.create({ code: "M-1", name: "Test", type: "hammadde", baseUom: "kg" }, [], AYSE);
      await db.$executeRawUnsafe(
        `UPDATE "items" SET "moving_avg_cost" = 999, "updated_at" = NOW() WHERE "code" = 'M-1'`,
      );

      const h = await repo.fieldHistory("items", "M-1", "moving_avg_cost");
      expect(h).toHaveLength(1);
      // Sessizce bir kullanıcıya yazmak yerine "bilinmiyor" der.
      expect(h[0]!.changedBy).toBe(null);
    });

    it("aktörü bilinmeyen değişiklikler sayılabilir", async () => {
      await items.create({ code: "M-1", name: "Test", type: "hammadde", baseUom: "kg" }, [], AYSE);
      await db.$executeRawUnsafe(
        `UPDATE "items" SET "safety_stock" = 5, "updated_at" = NOW() WHERE "code" = 'M-1'`,
      );
      const n = await repo.unattributed(new Date("2000-01-01"), new Date("2100-01-01"));
      expect(n).toBe(1);
    });

    it("AKTÖR BİR SONRAKİ İŞLEME SIZMAZ", async () => {
      // `SET LOCAL` yalnızca kendi işleminde yaşar; sızsaydı havuzdan
      // gelen bir sonraki bağlantı önceki kullanıcının kimliğiyle yazardı.
      await items.create({ code: "M-1", name: "A", type: "hammadde", baseUom: "kg" }, [], AYSE);
      await db.item.update({ where: { code: "M-1" }, data: { name: "B" } });
      const h = await repo.fieldHistory("items", "M-1", "name");
      expect(h[0]!.changedBy).toBe(null);
    });
  });

  describe("dokunulmazlık", () => {
    it("DEĞİŞİKLİK BELGESİ DEĞİŞTİRİLEMEZ", async () => {
      await items.create({ code: "M-1", name: "Test", type: "hammadde", baseUom: "kg" }, [], AYSE);
      await expect(
        db.$executeRawUnsafe(`UPDATE "master_data_changes" SET "changed_by" = NULL`),
      ).rejects.toThrow(/değiştirilemez/);
    });

    it("DEĞİŞİKLİK BELGESİ SİLİNEMEZ — değiştirilebilen iz, iz değildir", async () => {
      await items.create({ code: "M-1", name: "Test", type: "hammadde", baseUom: "kg" }, [], AYSE);
      await expect(
        db.$executeRawUnsafe(`DELETE FROM "master_data_changes"`),
      ).rejects.toThrow(/silinemez/);
    });
  });

  describe("sorgular", () => {
    it("geçmiş en yeni başta gelir", async () => {
      await items.create({ code: "M-1", name: "A", type: "hammadde", baseUom: "kg" }, [], AYSE);
      await db.item.update({ where: { code: "M-1" }, data: { name: "B" } });
      await db.item.update({ where: { code: "M-1" }, data: { name: "C" } });
      const h = await repo.fieldHistory("items", "M-1", "name");
      expect(h.map((c) => c.newValue)).toEqual(["C", "B"]);
    });

    it("tarih aralığı sorgusu yalnızca güncellemeleri döndürür", async () => {
      await items.create({ code: "M-1", name: "A", type: "hammadde", baseUom: "kg" }, [], AYSE);
      await db.item.update({ where: { code: "M-1" }, data: { name: "B" } });
      const rows = await repo.recent(new Date("2000-01-01"), new Date("2100-01-01"));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.field).toBe("name");
    });
  });
});
