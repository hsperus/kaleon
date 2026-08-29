/**
 * Uçtan uca yol testleri — HTTP sınırında.
 *
 * Birim testleri parçaların doğru olduğunu söyler; bu dosya PARÇALARIN
 * DOĞRU BAĞLANDIĞINI söyler. KAELON'da en pahalı hatalar tam burada
 * yaşandı: doğru principal yanlış tenant bağlamıyla eşleşti, üretim
 * derlemesi bomboş açıldı, durum sorgusu yan etki yaptı. Hiçbiri birim
 * testiyle görünmezdi.
 *
 * Route handler'ları Request alıp Response döndüren saf fonksiyonlardır;
 * sunucu ayağa kaldırmadan çağrılabilirler.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { POST as login } from "../app/api/auth/login/route.js";
import { POST as logout } from "../app/api/auth/logout/route.js";
import { GET as me } from "../app/api/auth/me/route.js";
import { POST as ask } from "../app/api/ask/route.js";
import { GET as health } from "../app/api/health/route.js";
import { sharedClient, disconnectAll } from "../src/db/client.js";
import { hashPassword } from "../src/auth/password.js";
import { provisionTenantSchema } from "../src/db/provision.js";

const enabled = Boolean(process.env["SHARED_DATABASE_URL"] && process.env["TENANT_DATABASE_URL"]);

const EMAIL = "e2e@kaelon.test";
const PASSWORD = "E2eTestParola2026!";
/** Var olmayan kullanıcı testi için — kilit sayacı da temizlenir. */
const MISSING_EMAIL = "yok@kaelon.test";

function req(url: string, init?: RequestInit & { cookie?: string }): Request {
  const headers = new Headers(init?.headers);
  headers.set("content-type", "application/json");
  if (init?.cookie) headers.set("cookie", init.cookie);
  return new Request(`http://localhost${url}`, { ...init, headers });
}

function cookieFrom(res: Response): string {
  const raw = res.headers.get("set-cookie") ?? "";
  return raw.split(";")[0] ?? "";
}

describe.skipIf(!enabled)("uçtan uca yollar", () => {
  let tenantId: string;

  beforeEach(async () => {
    const db = sharedClient();
    // Demo tenant'ı bağlamın çözebilmesi için gerekli.
    await provisionTenantSchema(db, "tenant_demo");
    const demo = await db.tenant.upsert({
      where: { slug: "demo" },
      create: { slug: "demo", name: "Demo A.Ş.", schemaName: "tenant_demo", status: "active" },
      update: { status: "active" },
    });
    tenantId = demo.id;

    // HER İKİ E-POSTANIN da sayacı temizlenir. Yalnızca EMAIL temizleniyordu;
    // "olmayan kullanıcı" testinin kullandığı adres her koşuda bir başarısız
    // deneme biriktiriyor ve beşinci koşuda hesap kilitlenip test kırılıyordu.
    // Testin kendi geçmişine bağlı olması, testi zamanla yalancı yapar.
    await db.loginAttempt.deleteMany({ where: { email: { in: [EMAIL, MISSING_EMAIL] } } });
    const user = await db.user.upsert({
      where: { email: EMAIL },
      create: {
        email: EMAIL,
        displayName: "E2E Kullanıcı",
        passwordHash: await hashPassword(PASSWORD),
      },
      update: { isActive: true, totpSecret: null, lastTotpStep: null },
    });
    await db.membership.upsert({
      where: { userId_tenantId: { userId: user.id, tenantId } },
      create: { userId: user.id, tenantId, roles: ["patron"] },
      update: { roles: ["patron"], isActive: true },
    });
  }, 60_000);

  afterAll(async () => {
    const db = sharedClient();
    await db.user.deleteMany({ where: { email: EMAIL } });
    await disconnectAll();
  });

  // ─────────────── sağlık ───────────────

  it("sağlık kontrolü GERÇEK sorgu atar", async () => {
    const res = await health(req("/api/health"));
    const body = (await res.json()) as { status: string; checks: { database: { ok: boolean } } };
    expect(res.status).toBe(200);
    expect(body.checks.database.ok).toBe(true);
  });

  it("canlılık kontrolü bağımlılığa bakmaz", async () => {
    const res = await health(req("/api/health?live=1"));
    expect((await res.json()).status).toBe("live");
  });

  // ─────────────── giriş ───────────────

  it("giriş → oturum → çıkış tam turu", async () => {
    const l = await login(req("/api/auth/login", { method: "POST", body: JSON.stringify({ email: EMAIL, password: PASSWORD }) }));
    expect(l.status).toBe(200);
    const cookie = cookieFrom(l);
    expect(cookie).toContain("kaelon_session=");

    const identity = await me(req("/api/auth/me", { cookie }));
    const who = (await identity.json()) as { roles: string[]; identitySource: string };
    expect(who.roles).toEqual(["patron"]);
    expect(who.identitySource).toBe("session");

    const out = await logout(req("/api/auth/logout", { method: "POST", cookie }));
    expect(out.status).toBe(200);

    // Oturum SUNUCUDA iptal edildi: aynı çerez artık oturum çözmez.
    const after = await me(req("/api/auth/me", { cookie }));
    const afterBody = (await after.json()) as { identitySource?: string };
    expect(afterBody.identitySource).not.toBe("session");
  }, 30_000);

  it("yanlış parola ile olmayan kullanıcı AYNI cevabı verir", async () => {
    const a = await login(req("/api/auth/login", { method: "POST", body: JSON.stringify({ email: EMAIL, password: "yanlisParola123" }) }));
    const b = await login(req("/api/auth/login", { method: "POST", body: JSON.stringify({ email: MISSING_EMAIL, password: "yanlisParola123" }) }));
    expect(a.status).toBe(b.status);
    expect(await a.json()).toEqual(await b.json());
  }, 30_000);

  it("bozuk gövde 400 döner, çökmez", async () => {
    const res = await login(new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{bozuk",
    }));
    expect(res.status).toBe(400);
  });

  // ─────────────── konuşma ───────────────

  it("soru sorulur, konuşma kimliği İLK olayda döner", async () => {
    const l = await login(req("/api/auth/login", { method: "POST", body: JSON.stringify({ email: EMAIL, password: PASSWORD }) }));
    const cookie = cookieFrom(l);

    const res = await ask(req("/api/ask", { method: "POST", cookie, body: JSON.stringify({ question: "Bankada ne kadar param var?" }) }));
    expect(res.status).toBe(200);
    const lines = (await res.text()).trim().split("\n").map((l) => JSON.parse(l));

    expect(lines[0]).toMatchObject({ type: "conversation" });
    expect(lines.some((e) => e.type === "tool_end" && e.ok)).toBe(true);
    expect(lines.at(-1)).toMatchObject({ type: "done" });
  }, 30_000);

  it("TAKİP SORUSU aynı konuşmaya yazılır", async () => {
    const l = await login(req("/api/auth/login", { method: "POST", body: JSON.stringify({ email: EMAIL, password: PASSWORD }) }));
    const cookie = cookieFrom(l);

    const first = await ask(req("/api/ask", { method: "POST", cookie, body: JSON.stringify({ question: "Bankada ne kadar param var?" }) }));
    const firstLines = (await first.text()).trim().split("\n").map((l) => JSON.parse(l));
    const convId = firstLines[0].id as string;

    const second = await ask(req("/api/ask", { method: "POST", cookie, body: JSON.stringify({ question: "Peki fabrikada ne oluyor?", conversationId: convId }) }));
    const secondLines = (await second.text()).trim().split("\n").map((l) => JSON.parse(l));
    expect(secondLines[0].id).toBe(convId);
    // İkinci soru kendi tool'unu seçmeli — geçmiş, güncel soruyu gölgelememeli.
    expect(secondLines.some((e) => e.type === "tool_end" && e.tool === "get_factory_wip")).toBe(true);
  }, 30_000);

  it("BAŞKASININ KONUŞMASINA YAZILAMAZ", async () => {
    const l = await login(req("/api/auth/login", { method: "POST", body: JSON.stringify({ email: EMAIL, password: PASSWORD }) }));
    const cookie = cookieFrom(l);
    const res = await ask(req("/api/ask", { method: "POST", cookie, body: JSON.stringify({ question: "test sorusu", conversationId: "00000000-0000-0000-0000-000000000000" }) }));
    expect(res.status).toBe(404);
  }, 30_000);

  it("çok kısa soru 400 döner", async () => {
    const l = await login(req("/api/auth/login", { method: "POST", body: JSON.stringify({ email: EMAIL, password: PASSWORD }) }));
    const res = await ask(req("/api/ask", { method: "POST", cookie: cookieFrom(l), body: JSON.stringify({ question: "a" }) }));
    expect(res.status).toBe(400);
  }, 30_000);
});
