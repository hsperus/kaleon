/**
 * Çekirdek güvenlik değişmezleri.
 *
 * Bu dosyadaki her test bir güvenlik sınırını korur. Biri kırmızıya dönerse
 * bu bir "test hatası" değil, bir güvenlik açığıdır.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createPrincipal, holds, missingPermissions, REDACTED } from "../src/kernel/rbac.js";
import { defineTool, toStrictJsonSchema } from "../src/kernel/tool.js";
import { ToolRegistry } from "../src/kernel/registry.js";
import { InMemoryAuditSink } from "../src/kernel/audit.js";
import { invokeTool } from "../src/kernel/invoke.js";
import { assertNotL4 } from "../src/kernel/authority.js";
import { buildRegistry } from "../src/app.js";
import { InMemoryDataSource } from "../src/data/memory.js";
import type { TenantContext } from "../src/kernel/types.js";
import type { Tool } from "../src/kernel/tool.js";

const TENANT: TenantContext = {
  tenantId: "t-orthaus",
  schema: "tenant_orthaus",
  locale: "tr-TR",
  baseCurrency: "TRY",
};

const patron = createPrincipal({ userId: "u1", tenantId: "t-orthaus", roles: ["patron"] });
const cfo = createPrincipal({ userId: "u2", tenantId: "t-orthaus", roles: ["cfo"] });
const uretim = createPrincipal({ userId: "u3", tenantId: "t-orthaus", roles: ["uretim_muduru"] });
const depo = createPrincipal({ userId: "u4", tenantId: "t-orthaus", roles: ["depo_sorumlusu"] });
const ik = createPrincipal({ userId: "u5", tenantId: "t-orthaus", roles: ["ik_muduru"] });

function ctx(principal = patron, audit = new InMemoryAuditSink()) {
  return {
    registry: buildRegistry(new InMemoryDataSource("t-orthaus")),
    audit,
    principal,
    tenant: TENANT,
    correlationId: "c-1",
    channel: "chat" as const,
  };
}

describe("L4 sınırı", () => {
  it("AuthorityLevel tipi 4'ü içermez — L4 tool'u derlenemez", () => {
    // @ts-expect-error 4 geçerli bir AuthorityLevel değildir.
    const forbidden: import("../src/kernel/types.js").AuthorityLevel = 4;
    expect(forbidden).toBe(4); // çalışma zamanında sayı, tipte yasak
  });

  it("resmî gönderim ima eden tool adı kayıtta reddedilir", () => {
    expect(() => assertNotL4("send_vat_declaration")).toThrow(/L4 sınırı/);
    expect(() => assertNotL4("execute_payment_order")).toThrow(/L4 sınırı/);
    expect(() => assertNotL4("grant_user_permission")).toThrow(/L4 sınırı/);
    expect(() => assertNotL4("delete_audit_log")).toThrow(/L4 sınırı/);
  });

  it("taslak üreten karşılığı serbesttir", () => {
    expect(() => assertNotL4("draft_vat_declaration")).not.toThrow();
  });
});

describe("Tool listesi filtresi — modelin görmediğini çağıramaması", () => {
  const registry = buildRegistry(new InMemoryDataSource("t-orthaus"));

  it("CFO banka tool'unu görür", () => {
    expect(registry.catalogFor(cfo).names).toContain("get_bank_balance");
  });

  it("üretim müdürü banka tool'unu HİÇ görmez", () => {
    expect(registry.catalogFor(uretim).names).not.toContain("get_bank_balance");
  });

  it("depo sorumlusu ne bankayı ne mesaiyi görür", () => {
    const names = registry.catalogFor(depo).names;
    expect(names).not.toContain("get_bank_balance");
    expect(names).not.toContain("get_overtime");
  });

  it("patron hepsini görür", () => {
    expect(registry.catalogFor(patron).names.length).toBe(registry.size);
  });

  it("katalog deterministik sıradadır — önbellek öneki bozulmaz", () => {
    const a = registry.catalogFor(cfo).all.map((t) => t.name);
    const b = registry.catalogFor(cfo).all.map((t) => t.name);
    expect(a).toEqual(b);
    const core = registry.catalogFor(patron).core.map((t) => t.name);
    expect(core).toEqual([...core].sort());
  });
});

describe("Invoker — çağrı anında yeniden kontrol", () => {
  it("listede olmayan tool'u model uydursa bile reddeder", async () => {
    const audit = new InMemoryAuditSink();
    const res = await invokeTool("get_bank_balance", { currency: null }, ctx(uretim, audit));
    expect(res.outcome.ok).toBe(false);
    if (!res.outcome.ok) expect(res.outcome.code).toBe("permission_denied");
  });

  it("reddedilen girişim de audit'e düşer", async () => {
    const audit = new InMemoryAuditSink();
    await invokeTool("get_bank_balance", { currency: null }, ctx(depo, audit));
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]?.outcome).toBe("denied");
    expect(audit.entries[0]?.userId).toBe("u4");
  });

  it("tanımsız tool adı hata döndürür, sessizce yutulmaz", async () => {
    const res = await invokeTool("uydurma_tool", {}, ctx(patron));
    expect(res.outcome.ok).toBe(false);
    if (!res.outcome.ok) expect(res.outcome.code).toBe("unknown_tool");
  });

  it("tenant uyuşmazlığı reddedilir", async () => {
    const foreign = createPrincipal({ userId: "x", tenantId: "t-baska", roles: ["patron"] });
    const res = await invokeTool("get_factory_wip", {}, { ...ctx(), principal: foreign });
    expect(res.outcome.ok).toBe(false);
    if (!res.outcome.ok) expect(res.outcome.code).toBe("tenant_mismatch");
  });

  it("şemaya uymayan girdi reddedilir", async () => {
    const res = await invokeTool("get_shipment_risk", { isoWeek: 99 }, ctx(patron));
    expect(res.outcome.ok).toBe(false);
    if (!res.outcome.ok) expect(res.outcome.code).toBe("invalid_input");
  });

  it("başarılı çağrı audit'e düşer ve kaynak taşır", async () => {
    const audit = new InMemoryAuditSink();
    const res = await invokeTool("get_factory_wip", {}, ctx(patron, audit));
    expect(res.outcome.ok).toBe(true);
    if (res.outcome.ok) {
      expect(res.outcome.sources.length).toBeGreaterThan(0);
      expect(res.outcome.sources[0]?.syncedAt).toBeTruthy();
    }
    expect(audit.entries[0]?.outcome).toBe("success");
  });
});

describe("Alan seviyesi maskeleme", () => {
  const input = { employeeQuery: "Hasan", department: null, period: "2026-05" };

  it("İK müdürü maaşı görür", async () => {
    const res = await invokeTool("get_overtime", input, ctx(ik));
    expect(res.outcome.ok).toBe(true);
    if (res.outcome.ok) {
      const rows = res.outcome.data as { grossSalaryTry: unknown }[];
      expect(rows[0]?.grossSalaryTry).toBe(62_000);
    }
  });

  it("üretim müdürü aynı kaydı görür ama maaş maskelenir", async () => {
    const res = await invokeTool("get_overtime", input, ctx(uretim));
    expect(res.outcome.ok).toBe(true);
    if (res.outcome.ok) {
      const rows = res.outcome.data as { grossSalaryTry: unknown; employeeName: string }[];
      expect(rows[0]?.employeeName).toBe("Hasan Turan");
      expect(rows[0]?.grossSalaryTry).toBe(REDACTED);
    }
  });
});

describe("RBAC yardımcıları", () => {
  it("modül jokeri çalışır", () => {
    expect(holds(patron, "finance:bank.read")).toBe(true);
    expect(holds(depo, "finance:bank.read")).toBe(false);
  });

  it("eksik izinler listelenir", () => {
    expect(missingPermissions(depo, ["finance:bank.read", "inventory:stock.read"])).toEqual([
      "finance:bank.read",
    ]);
  });
});

describe("Tool şeması", () => {
  it("strict JSON Schema üretir: additionalProperties false ve tam required", () => {
    const schema = toStrictJsonSchema(
      z.strictObject({ a: z.string(), b: z.number().nullable() }),
    );
    expect(schema["additionalProperties"]).toBe(false);
    expect(schema["required"]).toEqual(["a", "b"]);
    expect(schema["$schema"]).toBeUndefined();
  });

  it("geçersiz tool adı reddedilir", () => {
    expect(() =>
      defineTool({
        name: "Bad-Name",
        module: "operations",
        authority: 0,
        description: { tr: "x", en: "x" },
        input: z.strictObject({}),
        requires: [],
        execute: async () => ({ ok: true, data: null, sources: [] }),
      }),
    ).toThrow(/Geçersiz tool adı/);
  });

  it("aynı ad iki kez kaydedilemez", () => {
    const t = defineTool({
      name: "dummy_tool",
      module: "operations",
      authority: 0,
      description: { tr: "x", en: "x" },
      input: z.strictObject({}),
      requires: [],
      execute: async () => ({ ok: true, data: null, sources: [] }),
    });
    const r = new ToolRegistry();
    r.register(t as unknown as Tool<never, unknown>);
    expect(() => r.register(t as unknown as Tool<never, unknown>)).toThrow(/çakışması/);
  });
});
