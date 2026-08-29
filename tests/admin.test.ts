/**
 * Kullanıcı yönetimi.
 *
 * Buradaki testlerin çoğu YETKİ ve KİRACI SINIRI hakkında. Kullanıcı
 * tablosu kontrol düzlemindedir ve tüm tenant'ları kapsar; sorguya üyelik
 * koşulu konmazsa bir patron başka bir şirketin kullanıcılarını yönetebilir.
 * Çok kiracılı sistemlerde en pahalı hata sınıfı budur.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as admin from "../src/server/admin.js";
import { AdminError } from "../src/server/admin.js";
import { createPrincipal } from "../src/kernel/rbac.js";
import { sharedClient, disconnectAll } from "../src/db/client.js";
import { provisionTenantSchema } from "../src/db/provision.js";

const enabled = Boolean(process.env["SHARED_DATABASE_URL"]);
const principal = (role: string, userId: string, tenantId: string) =>
  createPrincipal({ userId, tenantId, roles: [role as never] });

describe.skipIf(!enabled)("kullanıcı yönetimi", () => {
  const db = sharedClient();
  let tenantA = "";
  let tenantB = "";
  let bossId = "";
  const EMAILS = ["admin-test-boss@kaelon.test", "admin-test-worker@kaelon.test", "admin-test-other@kaelon.test"];

  beforeEach(async () => {
    await provisionTenantSchema(db, "tenant_admin_a");
    await provisionTenantSchema(db, "tenant_admin_b");
    const a = await db.tenant.upsert({
      where: { slug: "admin-a" },
      create: { slug: "admin-a", name: "A Ltd", schemaName: "tenant_admin_a", status: "active" },
      update: { status: "active" },
    });
    const b = await db.tenant.upsert({
      where: { slug: "admin-b" },
      create: { slug: "admin-b", name: "B Ltd", schemaName: "tenant_admin_b", status: "active" },
      update: { status: "active" },
    });
    tenantA = a.id;
    tenantB = b.id;

    await db.user.deleteMany({ where: { email: { in: EMAILS } } });
    const boss = await db.user.create({
      data: { email: EMAILS[0]!, displayName: "Patron", passwordHash: "x" },
    });
    bossId = boss.id;
    await db.membership.create({ data: { userId: boss.id, tenantId: tenantA, roles: ["patron"] } });
  }, 90_000);

  afterAll(async () => {
    await db.user.deleteMany({ where: { email: { in: EMAILS } } });
    await disconnectAll();
  });

  const boss = () => principal("patron", bossId, tenantA);

  it("patron kendi tenant'ının kullanıcılarını listeler", async () => {
    const users = await admin.listUsers(boss(), tenantA);
    expect(users.map((u) => u.email)).toContain(EMAILS[0]);
  });

  it("YETKİSİZ ROL HİÇBİR ŞEY YAPAMAZ", async () => {
    for (const role of ["cfo", "ik_muduru", "uretim_muduru", "operator"]) {
      await expect(
        admin.listUsers(principal(role, bossId, tenantA), tenantA),
      ).rejects.toBeInstanceOf(AdminError);
    }
  });

  it("kullanıcı oluşturulur ve İLK GİRİŞ KODU döner", async () => {
    // Parola yönetici tarafından yazılmaz: yazsaydı o parola yönetici
    // tarafından bilinirdi ve çoğu yönetici herkese aynısını verir.
    const { resetCode, userId } = await admin.createUser(boss(), tenantA, {
      email: EMAILS[1]!,
      displayName: "Çalışan",
      roles: ["depo_sorumlusu"],
    });
    expect(resetCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{2}$/);
    const users = await admin.listUsers(boss(), tenantA);
    expect(users.find((u) => u.id === userId)?.roles).toEqual(["depo_sorumlusu"]);
  }, 30_000);

  it("BAŞKA TENANT'IN KULLANICISI YÖNETİLEMEZ", async () => {
    const other = await db.user.create({
      data: { email: EMAILS[2]!, displayName: "Öteki", passwordHash: "x" },
    });
    await db.membership.create({
      data: { userId: other.id, tenantId: tenantB, roles: ["patron"] },
    });

    // A'nın patronu, B'deki kullanıcıya dokunamaz.
    await expect(
      admin.setRoles(boss(), tenantA, { userId: other.id, roles: ["operator"] }),
    ).rejects.toThrow(/bulunamadı/i);
    await expect(admin.issueReset(boss(), tenantA, other.id)).rejects.toThrow(/bulunamadı/i);
    await expect(admin.enableTwoFactor(boss(), tenantA, other.id)).rejects.toThrow(/bulunamadı/i);
    await expect(
      admin.setActive(boss(), tenantA, { userId: other.id, active: false }),
    ).rejects.toThrow(/bulunamadı/i);

    // Listede de görünmez.
    const users = await admin.listUsers(boss(), tenantA);
    expect(users.map((u) => u.email)).not.toContain(EMAILS[2]);
  }, 30_000);

  it("KENDİ PATRON ROLÜNÜ KALDIRAMAZ", async () => {
    // Patronsuz kalan bir tenant, artık kimsenin kullanıcı ekleyemediği
    // bir tenant'tır ve geri almak için veritabanına elle girmek gerekir.
    await expect(
      admin.setRoles(boss(), tenantA, { userId: bossId, roles: ["cfo"] }),
    ).rejects.toThrow(/patron rolünüzü/i);
  });

  it("KENDİNİ PASİFLEŞTİREMEZ", async () => {
    await expect(
      admin.setActive(boss(), tenantA, { userId: bossId, active: false }),
    ).rejects.toThrow(/kendinizi/i);
  });

  it("bilinmeyen rol reddedilir", async () => {
    await expect(
      admin.setRoles(boss(), tenantA, { userId: bossId, roles: ["tanri"] }),
    ).rejects.toThrow(/bilinmeyen rol/i);
  });

  it("rolsüz kullanıcı olmaz", async () => {
    await expect(
      admin.setRoles(boss(), tenantA, { userId: bossId, roles: [] }),
    ).rejects.toThrow(/en az bir rol/i);
  });

  it("2FA SIRRI LİSTEDE TAŞINMAZ — yalnızca varlığı", async () => {
    const { userId } = await admin.createUser(boss(), tenantA, {
      email: EMAILS[1]!,
      displayName: "Çalışan",
      roles: ["operator"],
    });
    const { secret } = await admin.enableTwoFactor(boss(), tenantA, userId);
    expect(secret).toMatch(/^[A-Z2-7]+$/);

    const users = await admin.listUsers(boss(), tenantA);
    const row = users.find((u) => u.id === userId)!;
    expect(row.twoFactor).toBe(true);
    // Listeyi gören herkes herkesin ikinci faktörünü görmemeli.
    expect(JSON.stringify(users)).not.toContain(secret);
  }, 30_000);

  it("PASİFLEŞTİRME OTURUMLARI ANINDA DÜŞÜRÜR", async () => {
    const { userId } = await admin.createUser(boss(), tenantA, {
      email: EMAILS[1]!,
      displayName: "Çalışan",
      roles: ["operator"],
    });
    await db.session.create({
      data: {
        userId,
        tenantId: tenantA,
        tokenHash: `admin-test-${Date.now()}`,
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    expect((await admin.listUsers(boss(), tenantA)).find((u) => u.id === userId)?.activeSessions).toBe(1);

    await admin.setActive(boss(), tenantA, { userId, active: false });
    const after = (await admin.listUsers(boss(), tenantA)).find((u) => u.id === userId)!;
    expect(after.activeSessions).toBe(0);
    expect(after.membershipActive).toBe(false);
  }, 30_000);

  it("ÜYELİK PASİFLEŞİR, KULLANICI DEĞİL", async () => {
    // Aynı kişi başka bir şirkette çalışmaya devam ediyor olabilir.
    const { userId } = await admin.createUser(boss(), tenantA, {
      email: EMAILS[1]!,
      displayName: "Çalışan",
      roles: ["operator"],
    });
    await admin.setActive(boss(), tenantA, { userId, active: false });
    const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.isActive).toBe(true);
  }, 30_000);
});
