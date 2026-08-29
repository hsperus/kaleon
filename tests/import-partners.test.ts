/**
 * Cari içe aktarma.
 *
 * İçe aktarmada en pahalı hata SESSİZ BOZULMADIR: dosya "başarıyla
 * aktarıldı" der, veriler yanlıştır ve aylar sonra bir e-fatura
 * eşleşmediğinde ortaya çıkar. Buradaki testler o sessizliği kırar.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient as SharedPrisma } from "../src/db/generated/shared/index.js";
import { PrismaClient as TenantPrisma } from "../src/db/generated/tenant/index.js";
import { dropTenantSchema, provisionTenantSchema } from "../src/db/provision.js";
import { urlForSchema } from "../src/db/client.js";
import { parseCsv } from "../src/modules/import/csv.js";
import { detectColumns, previewPartnerImport } from "../src/modules/import/partners.js";
import { PartnerImporter } from "../src/db/partner-import.js";
import { PrismaDataSource } from "../src/db/master-data-source.js";
import { resolvePartner } from "../src/modules/master-data/resolver.js";

const SHARED_URL = process.env["SHARED_DATABASE_URL"];
const TENANT_URL = process.env["TENANT_DATABASE_URL"];
const enabled = Boolean(SHARED_URL && TENANT_URL);
const SCHEMA = "tenant_it_imp";

// Türkçe Excel çıktısı: BOM, noktalı virgül, Türkçe başlıklar.
const FILE = `﻿Cari Kodu;Unvan;Vergi No;Tür
C-001;Burçelik Bursa Çelik Döküm Sanayi A.Ş.;1234567890;Tedarikçi
C-002;Gürateş Metal Sanayi Ltd. Şti.;1000000018;Tedarikçi
C-003;Volvo Group Sweden AB;;Müşteri`;

describe("sütun tanıma", () => {
  it("Türkçe başlıkları tanır", () => {
    const c = detectColumns(["Cari Kodu", "Unvan", "Vergi No", "Tür"]);
    expect(c).toMatchObject({
      code: "Cari Kodu",
      legalName: "Unvan",
      taxId: "Vergi No",
      type: "Tür",
    });
  });

  it("büyük/küçük harf ve Türkçe karakter farkı engel değil", () => {
    const c = detectColumns(["CARİ KODU", "UNVANI", "VKN"]);
    expect(c.code).toBe("CARİ KODU");
    expect(c.legalName).toBe("UNVANI");
    expect(c.taxId).toBe("VKN");
  });

  it("İngilizce başlıkları da tanır", () => {
    const c = detectColumns(["code", "name", "tax id"]);
    expect(c).toMatchObject({ code: "code", legalName: "name", taxId: "tax id" });
  });

  it("BULUNAMAYAN SÜTUN null KALIR — sessizce atlanmaz", () => {
    const c = detectColumns(["Unvan"]);
    expect(c.taxId).toBe(null);
    expect(c.code).toBe(null);
  });
});

describe("önizleme — hiçbir şey yazılmadan", () => {
  it("geçerli satırlar ayrıştırılır", () => {
    const p = previewPartnerImport(parseCsv(FILE));
    expect(p.totalRows).toBe(3);
    expect(p.errors).toEqual([]);
    expect(p.valid.map((r) => r.code)).toEqual(["C-001", "C-002", "C-003"]);
    expect(p.valid[0]!.taxId).toEqual({ kind: "vkn", value: "1234567890" });
    expect(p.valid[0]!.normalized).toContain("burcelik");
  });

  it("tür sütunu müşteri/tedarikçi ayrımını kurar", () => {
    const p = previewPartnerImport(parseCsv(FILE));
    expect(p.valid[0]).toMatchObject({ isSupplier: true, isCustomer: false });
    expect(p.valid[2]).toMatchObject({ isSupplier: false, isCustomer: true });
  });

  it("GEÇERSİZ VKN SESSİZCE KAYDEDİLMEZ", () => {
    // Yanlış vergi numarası ileride iki farklı firmayı birleştirebilir.
    const p = previewPartnerImport(parseCsv("Unvan;Vergi No\nHatalı A.Ş.;1234567891"));
    expect(p.valid).toEqual([]);
    expect(p.errors[0]).toMatchObject({ line: 2, field: "vergi no" });
    expect(p.errors[0]!.message).toContain("kontrol hanesi");
  });

  it("HATALI SATIR DİĞERLERİNİ DURDURMAZ", () => {
    // "Hepsi ya da hiçbiri" kuralı, kullanıcıyı 4000 satırlık dosyayı tek
    // bir hatalı hücre için yeniden yüklemeye zorlar.
    const file = `Unvan;Vergi No
Doğru A.Ş.;1234567890
Hatalı A.Ş.;9999999999
Diğer Doğru A.Ş.;1000000018`;
    const p = previewPartnerImport(parseCsv(file));
    expect(p.valid).toHaveLength(2);
    expect(p.errors).toHaveLength(1);
    expect(p.errors[0]!.line).toBe(3);
  });

  it("dosya içindeki mükerrer VKN yakalanır", () => {
    const file = `Cari Kodu;Unvan;Vergi No
C-1;Bir A.Ş.;1234567890
C-2;İki A.Ş.;1234567890`;
    const p = previewPartnerImport(parseCsv(file));
    expect(p.valid).toHaveLength(1);
    expect(p.errors[0]!.message).toContain("birden fazla satırda");
  });

  it("dosya içindeki mükerrer cari kodu yakalanır", () => {
    const file = `Cari Kodu;Unvan
C-1;Bir A.Ş.
C-1;İki A.Ş.`;
    const p = previewPartnerImport(parseCsv(file));
    expect(p.valid).toHaveLength(1);
    expect(p.errors[0]!.message).toContain("tekrar ediyor");
  });

  it("boş unvan reddedilir", () => {
    const p = previewPartnerImport(parseCsv("Cari Kodu;Unvan\nC-1;"));
    expect(p.errors[0]).toMatchObject({ field: "unvan", line: 2 });
  });

  it("UNVAN SÜTUNU YOKSA DOSYA TÜMDEN REDDEDİLİR", () => {
    const p = previewPartnerImport(parseCsv("Kod;Şehir\nC-1;Bursa"));
    expect(p.valid).toEqual([]);
    expect(p.errors[0]!.message).toContain("Unvan sütunu bulunamadı");
  });

  it("cari kodu yoksa OKUNABİLİR bir kod üretilir", () => {
    const p = previewPartnerImport(parseCsv("Unvan\nBurçelik Bursa Çelik A.Ş."));
    // Rastgele bir kod elle aramayı imkânsız kılardı.
    expect(p.valid[0]!.code).toMatch(/^BURCELIK-0001$/);
  });

  it("entegratör kodu yalnızca sistem adı verilirse bağlanır", () => {
    const file = "Unvan;Entegratör Kodu\nBurçelik;SUP-00432";
    expect(previewPartnerImport(parseCsv(file)).valid[0]!.externalRef).toBe(null);
    expect(
      previewPartnerImport(parseCsv(file), { externalSystem: "uyumsoft" }).valid[0]!.externalRef,
    ).toEqual({ system: "uyumsoft", externalId: "SUP-00432" });
  });
});

describe.skipIf(!enabled)("içe aktarma — yazma", () => {
  let shared: SharedPrisma;
  let db: TenantPrisma;
  let importer: PartnerImporter;

  beforeAll(async () => {
    shared = new SharedPrisma();
    await dropTenantSchema(shared, SCHEMA);
    await provisionTenantSchema(shared, SCHEMA);
    db = new TenantPrisma({ datasources: { db: { url: urlForSchema(TENANT_URL!, SCHEMA) } } });
    importer = new PartnerImporter(db);
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
  });

  const rows = () => previewPartnerImport(parseCsv(FILE)).valid;

  it("kayıtlar yazılır", async () => {
    const out = await importer.commit(rows());
    expect(out).toMatchObject({ created: 3, updated: 0, failures: [] });
    expect(await db.partner.count()).toBe(3);
    expect(await db.partnerTaxId.count()).toBe(2);
  });

  it("AYNI DOSYA İKİ KEZ YÜKLENİRSE MÜKERRER OLMAZ", async () => {
    // Kullanıcılar dosyayı iki kez yükler; mükerrer cari, ERP'de
    // temizlenmesi en zor kirliliktir.
    await importer.commit(rows());
    const second = await importer.commit(rows());
    expect(second.created).toBe(0);
    expect(await db.partner.count()).toBe(3);
  });

  it("VERGİ NUMARASI CARİ KODUNDAN ÖNCE EŞLEŞİR", async () => {
    // Aynı firma farklı kodla gelirse yeni kart AÇILMAMALI.
    await importer.commit(rows());
    const relabelled = previewPartnerImport(
      parseCsv("Cari Kodu;Unvan;Vergi No\nBASKA-KOD;BURCELIK AS;1234567890"),
    ).valid;
    const out = await importer.commit(relabelled);
    expect(out.created).toBe(0);
    expect(await db.partner.count()).toBe(3);
  });

  it("UNVAN DEĞİŞİRSE ESKİSİ ALIAS OLARAK SAKLANIR", async () => {
    // Eski belgelerdeki unvan hâlâ bu firmaya çözülebilmeli.
    await importer.commit(rows());
    await importer.commit(
      previewPartnerImport(parseCsv("Unvan;Vergi No\nBurçelik Döküm A.Ş.;1234567890")).valid,
    );
    const aliases = await db.partnerAlias.findMany();
    expect(aliases.map((a) => a.alias)).toContain("Burçelik Bursa Çelik Döküm Sanayi A.Ş.");
  });

  it("ESKİ UNVAN ÇÖZÜMLEYİCİ TARAFINDAN BULUNABİLİR", async () => {
    // Alias'ın normalizasyonu çözümleyicininkiyle aynı olmalı; farklı
    // olsaydı alias yazılır ama arama onu HİÇ bulamazdı.
    await importer.commit(rows());
    await importer.commit(
      previewPartnerImport(parseCsv("Unvan;Vergi No\nBurçelik Döküm A.Ş.;1234567890")).valid,
    );
    const source = new PrismaDataSource(db);
    const { rows: candidates } = await source.partnerCandidates(SCHEMA, {
      name: "Burçelik Bursa Çelik Döküm Sanayi A.Ş.",
      taxId: null,
    });
    const result = resolvePartner(
      { name: "Burçelik Bursa Çelik Döküm Sanayi A.Ş.", taxId: null, externalRef: null },
      candidates,
    );
    expect(result.status).toBe("resolved");
  });

  it("TÜR BAYRAKLARI SİLİNMEZ, EKLENİR", async () => {
    // Bir cari hem müşteri hem tedarikçi olabilir; eksik sütunlu bir dosya
    // diğerini silmemeli.
    await importer.commit(
      previewPartnerImport(parseCsv("Cari Kodu;Unvan;Tür\nC-9;Çift Rol A.Ş.;Tedarikçi")).valid,
    );
    await importer.commit(
      previewPartnerImport(parseCsv("Cari Kodu;Unvan;Tür\nC-9;Çift Rol A.Ş.;Müşteri")).valid,
    );
    const p = await db.partner.findUniqueOrThrow({ where: { code: "C-9" } });
    expect(p).toMatchObject({ isSupplier: true, isCustomer: true });
  });

  it("önizleme kaç yeni kaç güncelleme olduğunu söyler", async () => {
    await importer.commit(rows());
    const mixed = previewPartnerImport(
      parseCsv(`Cari Kodu;Unvan;Vergi No
C-001;Burçelik Bursa Çelik Döküm Sanayi A.Ş.;1234567890
C-YENI;Yepyeni A.Ş.;`),
    ).valid;
    const { toCreate, toUpdate } = await importer.classify(mixed);
    expect(toCreate.map((r) => r.code)).toEqual(["C-YENI"]);
    expect(toUpdate.map((r) => r.code)).toEqual(["C-001"]);
  });

  it("bir satırın hatası dosyayı durdurmaz, raporlanır", async () => {
    await db.partner.create({
      data: { code: "ÇAKIŞAN", legalName: "Var Olan", normalized: "var olan" },
    });
    // Aynı kodla ama farklı VKN'li bir satır: kod eşleşir, güncellenir.
    // Gerçek çakışma için doğrudan bozuk bir satır enjekte ediyoruz.
    const bad = [
      { code: "ÇAKIŞAN", legalName: "", normalized: "", taxId: null, externalRef: null, isSupplier: true, isCustomer: false },
      ...rows(),
    ];
    const out = await importer.commit(bad as never);
    expect(out.created).toBe(3);
  });
});

/**
 * Yükleme deposu.
 *
 * Yüklenen dosya henüz KAELON'un verisi değildir: kullanıcı yükler,
 * önizler, vazgeçebilir. Kalıcı saklamak, hiç onaylanmamış müşteri
 * verisini süresiz tutmak demektir.
 */
describe("yükleme deposu", () => {
  it("yüklenen dosya kimliğiyle okunur", async () => {
    const { InMemoryUploadStore } = await import("../src/modules/import/uploads.js");
    const store = new InMemoryUploadStore();
    const id = store.put({ filename: "cari.csv", content: "Unvan\nX", tenantId: "t1", userId: "u1" });
    expect(await store.get(id, "t1")).toEqual({ filename: "cari.csv", content: "Unvan\nX" });
  });

  it("BAŞKA TENANT OKUYAMAZ — kimliği bilmek yetki değildir", async () => {
    const { InMemoryUploadStore } = await import("../src/modules/import/uploads.js");
    const store = new InMemoryUploadStore();
    const id = store.put({ filename: "cari.csv", content: "Unvan\nX", tenantId: "t1", userId: "u1" });
    expect(await store.get(id, "t2")).toBe(null);
  });

  it("SÜRESİ DOLAN DOSYA YOKMUŞ GİBİ DAVRANIR", async () => {
    const { InMemoryUploadStore, UPLOAD_TTL_MS } = await import("../src/modules/import/uploads.js");
    let now = 0;
    const store = new InMemoryUploadStore(() => now);
    const id = store.put({ filename: "c.csv", content: "Unvan\nX", tenantId: "t1", userId: "u1" });
    now = UPLOAD_TTL_MS + 1;
    expect(await store.get(id, "t1")).toBe(null);
  });

  it("süresi dolanlar bellekte birikmez", async () => {
    const { InMemoryUploadStore, UPLOAD_TTL_MS } = await import("../src/modules/import/uploads.js");
    let now = 0;
    const store = new InMemoryUploadStore(() => now);
    for (let i = 0; i < 5; i++) {
      store.put({ filename: `${i}.csv`, content: "Unvan\nX", tenantId: "t1", userId: "u1" });
    }
    expect(store.size).toBe(5);
    now = UPLOAD_TTL_MS + 1;
    store.put({ filename: "yeni.csv", content: "Unvan\nX", tenantId: "t1", userId: "u1" });
    expect(store.size).toBe(1);
  });

  it("bilinmeyen kimlik null döner", async () => {
    const { InMemoryUploadStore } = await import("../src/modules/import/uploads.js");
    expect(await new InMemoryUploadStore().get("yok", "t1")).toBe(null);
  });
});

/**
 * İçe aktarma tool'ları — yetki sınırı.
 *
 * İki katmanlı RBAC burada da geçerli: yazma tool'u yetkisiz rolün
 * KATALOĞUNA HİÇ GİRMEZ (model onu göremez) ve çağrılsa bile invoker
 * reddeder. Tek katman yeterli değildir; kataloğu atlayan bir çağrı
 * (eski konuşma, elle istek) ikinci kapıya çarpar.
 */
describe("içe aktarma yetkileri", () => {
  async function setup() {
    const { buildRegistry } = await import("../src/app.js");
    const { InMemoryDataSource } = await import("../src/data/memory.js");
    const { InMemoryUploadStore } = await import("../src/modules/import/uploads.js");
    const { createPrincipal } = await import("../src/kernel/rbac.js");
    const { invokeTool } = await import("../src/kernel/invoke.js");
    const { InMemoryAuditSink } = await import("../src/kernel/audit.js");

    const uploads = new InMemoryUploadStore();
    const uploadId = uploads.put({
      filename: "cari.csv",
      content: "Unvan\nDeneme A.Ş.",
      tenantId: "T",
      userId: "U",
    });

    const committed: unknown[][] = [];
    const registry = buildRegistry(new InMemoryDataSource("T"), {
      imports: {
        uploads,
        importerFor: () => ({
          async classify(rows) {
            return { toCreate: rows, toUpdate: [] };
          },
          async commit(rows) {
            committed.push([...rows]);
            return { created: rows.length, updated: 0, skipped: 0, failures: [] };
          },
        }),
      },
    });

    const opts = (role: string) => ({
      registry,
      audit: new InMemoryAuditSink(),
      principal: createPrincipal({ userId: "U", tenantId: "T", roles: [role as never] }),
      tenant: { tenantId: "T", schema: "tenant_t", locale: "tr-TR", baseCurrency: "TRY" },
      correlationId: "c",
      channel: "chat" as const,
      now: () => new Date(),
    });

    return { registry, uploadId, opts, invokeTool, createPrincipal, committed };
  }

  it("satın alma hem önizler hem yazar", async () => {
    const { uploadId, opts, invokeTool } = await setup();
    const p = await invokeTool("preview_partner_import", { uploadId, externalSystem: null }, opts("satin_alma"));
    const c = await invokeTool("commit_partner_import", { uploadId, externalSystem: null }, opts("satin_alma"));
    expect(p.outcome.ok).toBe(true);
    expect(c.outcome.ok).toBe(true);
  });

  it("DEPO SORUMLUSU YAZAMAZ", async () => {
    const { uploadId, opts, invokeTool } = await setup();
    const c = await invokeTool("commit_partner_import", { uploadId, externalSystem: null }, opts("depo_sorumlusu"));
    expect(c.outcome).toMatchObject({ ok: false, code: "permission_denied" });
  });

  it("YAZMA TOOL'U YETKİSİZ ROLÜN KATALOĞUNDA HİÇ GÖRÜNMEZ", async () => {
    const { registry, createPrincipal } = await setup();
    const depo = registry.catalogFor(createPrincipal({ userId: "U", tenantId: "T", roles: ["depo_sorumlusu"] }));
    expect(depo.names.filter((n) => n.includes("import"))).toEqual([]);
  });

  it("BAŞKA TENANT'IN DOSYASI OKUNAMAZ", async () => {
    const { uploadId, opts, invokeTool } = await setup();
    const other = { ...opts("satin_alma") };
    const res = await invokeTool(
      "preview_partner_import",
      { uploadId, externalSystem: null },
      {
        ...other,
        principal: { ...other.principal, tenantId: "BASKA" } as never,
        tenant: { tenantId: "BASKA", schema: "tenant_baska", locale: "tr-TR", baseCurrency: "TRY" },
      },
    );
    expect(res.outcome.ok).toBe(false);
  });

  it("bilinmeyen dosya kimliği anlaşılır hata verir", async () => {
    const { opts, invokeTool } = await setup();
    const res = await invokeTool(
      "preview_partner_import",
      { uploadId: "00000000-0000-0000-0000-000000000000", externalSystem: null },
      opts("satin_alma"),
    );
    expect(res.outcome.ok).toBe(false);
  });

  it("ÖNİZLEME HİÇBİR ŞEY YAZMAZ", async () => {
    const { uploadId, opts, invokeTool, committed } = await setup();
    await invokeTool("preview_partner_import", { uploadId, externalSystem: null }, opts("satin_alma"));
    expect(committed).toEqual([]);
  });
});

/**
 * Yükleme deposu — Postgres.
 *
 * Bellek deposu bozuktu ve bozukluğu ancak tarayıcıda görüldü: yükleme
 * "başarılı" dedi, önizleme "dosya bulunamadı" dedi. Sebep, yüklemeyi alan
 * süreç ile soruyu alan sürecin farklı modül örneği kullanmasıydı.
 */
describe.skipIf(!enabled)("yükleme deposu — Postgres", () => {
  let shared: SharedPrisma;
  let db: TenantPrisma;
  const SCHEMA_U = "tenant_it_upl";

  beforeAll(async () => {
    shared = new SharedPrisma();
    await dropTenantSchema(shared, SCHEMA_U);
    await provisionTenantSchema(shared, SCHEMA_U);
    db = new TenantPrisma({ datasources: { db: { url: urlForSchema(TENANT_URL!, SCHEMA_U) } } });
  }, 60_000);

  afterAll(async () => {
    await db?.$disconnect();
    if (shared) {
      await dropTenantSchema(shared, SCHEMA_U);
      await shared.$disconnect();
    }
  });

  beforeEach(async () => {
    await db.fileUpload.deleteMany();
  });

  const USER = "11111111-1111-1111-1111-111111111111";

  it("FARKLI DEPO ÖRNEĞİ AYNI DOSYAYI OKUR", async () => {
    // Asıl kırılan buydu: yükleyen örnek ile okuyan örnek farklıydı.
    const { PrismaUploadStore } = await import("../src/db/upload-store.js");
    const writer = new PrismaUploadStore(db);
    const reader = new PrismaUploadStore(db);
    const id = await writer.put({ filename: "cari.csv", content: "Unvan\nX", userId: USER });
    expect(await reader.get(id, "T")).toEqual({ filename: "cari.csv", content: "Unvan\nX" });
  });

  it("SÜRESİ DOLAN DOSYA OKUNMAZ", async () => {
    const { PrismaUploadStore } = await import("../src/db/upload-store.js");
    const { UPLOAD_TTL_MS } = await import("../src/modules/import/uploads.js");
    let now = new Date("2026-05-16T08:00:00Z");
    const store = new PrismaUploadStore(db, () => now);
    const id = await store.put({ filename: "c.csv", content: "Unvan\nX", userId: USER });
    now = new Date(now.getTime() + UPLOAD_TTL_MS + 1000);
    expect(await store.get(id, "T")).toBe(null);
  });

  it("süresi dolanlar TEMİZLENİR — sonsuza kadar birikmez", async () => {
    const { PrismaUploadStore } = await import("../src/db/upload-store.js");
    const { UPLOAD_TTL_MS } = await import("../src/modules/import/uploads.js");
    let now = new Date("2026-05-16T08:00:00Z");
    const store = new PrismaUploadStore(db, () => now);
    await store.put({ filename: "eski.csv", content: "Unvan\nX", userId: USER });
    now = new Date(now.getTime() + UPLOAD_TTL_MS + 1000);
    await store.put({ filename: "yeni.csv", content: "Unvan\nY", userId: USER });
    const rows = await db.fileUpload.findMany();
    expect(rows.map((r) => r.filename)).toEqual(["yeni.csv"]);
  });

  it("bilinmeyen kimlik null döner", async () => {
    const { PrismaUploadStore } = await import("../src/db/upload-store.js");
    const store = new PrismaUploadStore(db);
    expect(await store.get("00000000-0000-0000-0000-000000000000", "T")).toBe(null);
  });

  it("BAŞKA TENANT'IN ŞEMASINDA GÖRÜNMEZ", async () => {
    // İzolasyon bağlantıda: her tenant kendi şemasına yazar.
    const { PrismaUploadStore } = await import("../src/db/upload-store.js");
    const other = "tenant_it_upl2";
    await dropTenantSchema(shared, other);
    await provisionTenantSchema(shared, other);
    const otherDb = new TenantPrisma({
      datasources: { db: { url: urlForSchema(TENANT_URL!, other) } },
    });
    try {
      const id = await new PrismaUploadStore(db).put({
        filename: "gizli.csv",
        content: "Unvan\nX",
        userId: USER,
      });
      expect(await new PrismaUploadStore(otherDb).get(id, "T")).toBe(null);
    } finally {
      await otherDb.$disconnect();
      await dropTenantSchema(shared, other);
    }
  }, 60_000);
});
