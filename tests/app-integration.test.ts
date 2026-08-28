/**
 * Uygulama katmanı entegrasyonu.
 *
 * Tarayıcıda elle doğruladığım davranışı teste çeviriyorum — elle doğrulama
 * bir kez geçerlidir, test her değişiklikte geçerlidir.
 */

import { describe, expect, it } from "vitest";
import { runConversation } from "../src/ai/runner.js";
import { ScriptedCompleter } from "../src/ai/scripted.js";
import { buildRegistry } from "../src/app.js";
import { InMemoryDataSource } from "../src/data/memory.js";
import { InMemoryAuditSink } from "../src/kernel/audit.js";
import { createPrincipal } from "../src/kernel/rbac.js";
import type { TenantContext } from "../src/kernel/types.js";

const TENANT: TenantContext = { tenantId: "demo", schema: "tenant_demo", locale: "tr-TR", baseCurrency: "TRY" };

function run(question: string, role: "patron" | "depo_sorumlusu" | "uretim_muduru") {
  const audit = new InMemoryAuditSink();
  const registry = buildRegistry(new InMemoryDataSource());
  return runConversation(
    { gateway: new ScriptedCompleter(), registry, audit },
    {
      question,
      principal: createPrincipal({ userId: "u1", tenantId: "demo", roles: [role] }),
      tenant: TENANT,
      correlationId: "c1",
      channel: "chat",
      task: "lookup",
      display: { name: "Cebrail Karaarslan", roleLabel: role, companyName: "Orthaus" },
      now: () => new Date("2026-05-16T08:00:00.000Z"),
    },
  ).then((r) => ({ ...r, audit }));
}

describe("uygulama zinciri — demo modu", () => {
  it("patron fabrika sorusuna kaynaklı cevap alır", async () => {
    const r = await run("Şu an fabrikada ne oluyor?", "patron");
    expect(r.toolCalls.map((c) => c.tool)).toEqual(["get_factory_wip"]);
    expect(r.answer).toContain("142 aktif iş emri");
    expect(r.answer).toContain("Kaynak:");
    expect(r.audit.entries[0]?.outcome).toBe("success");
  });

  it("DEPO SORUMLUSU banka sorusunda tool ÇAĞIRMADAN reddedilir", async () => {
    const r = await run("Bankadaki nakit pozisyonu ne kadar?", "depo_sorumlusu");
    expect(r.toolCalls).toHaveLength(0);
    expect(r.answer).toContain("yetkiniz yok");
  });

  it("CFO aynı soruya cevap alır — fark rolde, soruda değil", async () => {
    const registry = buildRegistry(new InMemoryDataSource());
    const cfo = createPrincipal({ userId: "u2", tenantId: "demo", roles: ["cfo"] });
    expect(registry.catalogFor(cfo).names).toContain("get_bank_balance");
  });

  it("rol değişince görünen tool sayısı gerçekten değişir", () => {
    const registry = buildRegistry(new InMemoryDataSource());
    const patron = createPrincipal({ userId: "u", tenantId: "demo", roles: ["patron"] });
    const depo = createPrincipal({ userId: "u", tenantId: "demo", roles: ["depo_sorumlusu"] });
    expect(registry.catalogFor(patron).names.length).toBe(registry.size);
    expect(registry.catalogFor(depo).names.length).toBeLessThan(registry.size);
    expect(registry.catalogFor(depo).names.length).toBeGreaterThan(0);
  });

  it("tanımadığı soruda uydurmaz, demo sınırını söyler", async () => {
    const r = await run("Gelecek çeyrek cirosu ne olacak?", "patron");
    expect(r.toolCalls).toHaveLength(0);
    expect(r.answer).toContain("demo modunda cevaplayamıyorum");
  });
});
