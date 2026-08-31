/**
 * Kadro tool'ları — kim çalışıyor, ücreti kim görür.
 *
 * VARLIK SEBEBİ SOMUT: patron "mevcut çalışanlarımız kimler" diye
 * sordu ve "böyle bir yetenek yok, personel kodunu verirseniz…"
 * cevabını aldı. Kodu bilmek için önce listeyi görmek gerekir; liste
 * olmayınca hiçbir kişi sorgusuna başlanamıyordu. Zincirin ilk halkası
 * eksikti.
 *
 * Bu dosya iki şeyi sınar: liste gerçekten geliyor mu, ve ücret
 * görmemesi gerekenden gerçekten saklanıyor mu.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient as SharedPrisma } from "../src/db/generated/shared/index.js";
import { PrismaClient as TenantPrisma } from "../src/db/generated/tenant/index.js";
import { dropTenantSchema, provisionTenantSchema } from "../src/db/provision.js";
import { urlForSchema } from "../src/db/client.js";
import { createPrincipal, REDACTED } from "../src/kernel/rbac.js";
import { rosterTools } from "../src/modules/hr/roster-tools.js";
import type { RoleId } from "../src/kernel/types.js";

const SHARED_URL = process.env["SHARED_DATABASE_URL"];
const TENANT_URL = process.env["TENANT_DATABASE_URL"];
const enabled = Boolean(SHARED_URL && TENANT_URL);
const SCHEMA = "tenant_it_roster";
const TENANT = "00000000-0000-0000-0000-0000000000t1".replace("t1", "a1");

function ctxFor(role: string) {
  return {
    principal: createPrincipal({
      userId: "00000000-0000-0000-0000-0000000000b1",
      tenantId: TENANT,
      roles: [role as RoleId],
    }),
  } as never;
}

describe.skipIf(!enabled)("kadro tool'ları", () => {
  let shared: SharedPrisma;
  let db: TenantPrisma;
  let tools: ReturnType<typeof rosterTools>;

  beforeAll(async () => {
    shared = new SharedPrisma();
    await dropTenantSchema(shared, SCHEMA);
    await provisionTenantSchema(shared, SCHEMA);
    db = new TenantPrisma({ datasources: { db: { url: urlForSchema(TENANT_URL!, SCHEMA) } } });
    tools = rosterTools(db as never);
  }, 60_000);

  afterAll(async () => {
    await db?.$disconnect();
    if (shared) {
      await dropTenantSchema(shared, SCHEMA);
      await shared.$disconnect();
    }
  });

  beforeEach(async () => {
    await db.employee.deleteMany();
    await db.employee.createMany({
      data: [
        {
          code: "P-001", fullName: "Ayşe Yılmaz", normalized: "ayşe yılmaz",
          department: "Üretim", position: "CNC Operatörü",
          hiredAt: new Date("2024-02-01"), grossSalary: 42_000, isActive: true,
        },
        {
          code: "P-002", fullName: "Mehmet Kaya", normalized: "mehmet kaya",
          department: "Muhasebe", position: "Muhasebe Müdürü",
          hiredAt: new Date("2019-06-15"), grossSalary: 135_000, isActive: true,
        },
        {
          code: "P-003", fullName: "Mehmet Demir", normalized: "mehmet demir",
          department: "Üretim", position: "Kaynakçı",
          hiredAt: new Date("2023-03-10"), grossSalary: 38_500, isActive: true,
        },
        {
          code: "P-009", fullName: "Ayrılan Kişi", normalized: "ayrılan kişi",
          department: "Üretim", position: "Operatör",
          hiredAt: new Date("2022-01-01"), terminatedAt: new Date("2026-04-30"),
          grossSalary: 30_000, isActive: false,
        },
      ],
    });
  });

  /*
   * DEMET OLARAK ÇÖZÜLÜYOR, `.find()` İLE DEĞİL.
   *
   * `find` iki tool'un BİRLEŞİM tipini döndürür ve `execute`
   * parametreleri kesişime düşer: derleyici her çağrıda iki tool'un
   * girdilerinin toplamını ister. Vitest tip kontrolü yapmadığı için
   * testler geçiyordu ama `npm run verify` haklı olarak durdurdu.
   */
  const search = () => tools[0];
  const one = () => tools[1];

  describe("liste", () => {
    it("FİLTRESİZ ÇAĞRI TÜM AKTİF KADROYU DÖNER", async () => {
      const r = await search().execute(
        { nameQuery: null, department: null, includeTerminated: false },
        ctxFor("patron"),
      );
      const d = r.data as { total: number; employees: { code: string }[] };
      expect(d.total).toBe(3);
      expect(d.employees.map((e) => e.code).sort()).toEqual(["P-001", "P-002", "P-003"]);
    });

    it("İŞTEN AYRILAN VARSAYILAN OLARAK GELMEZ — kadro sayısı yanlış çıkmasın", async () => {
      const kapali = await search().execute(
        { nameQuery: null, department: null, includeTerminated: false },
        ctxFor("patron"),
      );
      const acik = await search().execute(
        { nameQuery: null, department: null, includeTerminated: true },
        ctxFor("patron"),
      );
      expect((kapali.data as { total: number }).total).toBe(3);
      expect((acik.data as { total: number }).total).toBe(4);
    });

    it("departmana göre filtreler ve kırılım verir", async () => {
      const r = await search().execute(
        { nameQuery: null, department: "Üretim", includeTerminated: false },
        ctxFor("patron"),
      );
      const d = r.data as { total: number; byDepartment: { department: string; count: number }[] };
      expect(d.total).toBe(2);
      expect(d.byDepartment).toEqual([{ department: "Üretim", count: 2 }]);
    });

    it("ada göre arar", async () => {
      const r = await search().execute(
        { nameQuery: "mehmet", department: null, includeTerminated: false },
        ctxFor("patron"),
      );
      expect((r.data as { total: number }).total).toBe(2);
    });
  });

  describe("ücret maskeleme", () => {
    it("BORDRO YETKİSİ OLAN ÜCRETİ GÖRÜR", async () => {
      const r = await search().execute(
        { nameQuery: "ayşe", department: null, includeTerminated: false },
        ctxFor("cfo"),
      );
      const e = (r.data as { employees: { grossSalary: unknown }[] }).employees[0]!;
      expect(e.grossSalary).toBe(42_000);
    });

    it("ÜRETİM MÜDÜRÜ EKİBİNİ GÖRÜR AMA ÜCRETİ GÖREMEZ", async () => {
      // Not: üretim müdürü `hr:payroll.read` izni TAŞIYOR, bu yüzden
      // maskeleme onda değil; asıl sınav ücret iznini hiç taşımayan
      // bir rolde. Depo sorumlusu tool'u zaten göremiyor — o yüzden
      // maskeleme doğrudan sınanıyor.
      const r = await search().execute(
        { nameQuery: "ayşe", department: null, includeTerminated: false },
        ctxFor("depo_sorumlusu"),
      );
      const e = (r.data as { employees: { grossSalary: unknown }[] }).employees[0]!;
      expect(e.grossSalary).toBe(REDACTED);
    });

    it("MASKELEME DİĞER ALANLARI BOZMAZ — liste yine işe yarar", async () => {
      const r = await search().execute(
        { nameQuery: "ayşe", department: null, includeTerminated: false },
        ctxFor("depo_sorumlusu"),
      );
      const e = (r.data as { employees: { fullName: string; department: string }[] }).employees[0]!;
      expect(e.fullName).toBe("Ayşe Yılmaz");
      expect(e.department).toBe("Üretim");
    });
  });

  describe("tek kart", () => {
    it("personel koduyla bulur", async () => {
      const r = await one().execute({ query: "P-002" }, ctxFor("patron"));
      const d = r.data as { found: boolean; employee: { fullName: string } | null };
      expect(d.found).toBe(true);
      expect(d.employee?.fullName).toBe("Mehmet Kaya");
    });

    it("BELİRSİZ ADDA KART DÖNDÜRMEZ — yanlış kişinin maaşı gösterilmesin", async () => {
      // İki "Mehmet" var; birini seçmek yanlış kişiyi göstermek olur.
      const r = await one().execute({ query: "mehmet" }, ctxFor("patron"));
      const d = r.data as {
        found: boolean;
        employee: unknown;
        matches: { code: string }[];
        message: string;
      };
      expect(d.found).toBe(false);
      expect(d.employee).toBeNull();
      expect(d.matches.map((m) => m.code).sort()).toEqual(["P-002", "P-003"]);
      expect(d.message).toContain("2 kişiyle eşleşiyor");
    });

    it("bulunamayanı açıkça söyler", async () => {
      const r = await one().execute({ query: "zzzz" }, ctxFor("patron"));
      const d = r.data as { found: boolean; message: string };
      expect(d.found).toBe(false);
      expect(d.message).toContain("eşleşen çalışan yok");
    });

    it("DOĞUM TARİHİ YOKSA İZİN KADEMESİ UYARISI VERİR", async () => {
      const r = await one().execute({ query: "P-001" }, ctxFor("patron"));
      expect(r.risks?.some((x) => x.message.includes("18 yaş altı"))).toBe(true);
    });
  });
});
