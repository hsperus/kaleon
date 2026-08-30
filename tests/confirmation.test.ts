/**
 * İnsan onayı kapısı.
 *
 * Anayasanın son halkası: "AI hazırlar. Sistem doğrular. İNSAN ONAYLAR."
 * Bu dosya o halkanın PROMPTLA DEĞİL KODLA kurulduğunu sınar — model ne
 * derse desin, yazma tool'u kullanıcı onaylamadan çalışmaz.
 *
 * Buradaki testlerin çoğu "çalışmamalı" testidir. Bir kapının kapalı
 * olduğunu göstermek, açık olduğunu göstermekten daha önemlidir.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineTool } from "../src/kernel/tool.js";
import { ToolRegistry } from "../src/kernel/registry.js";
import { InMemoryAuditSink } from "../src/kernel/audit.js";
import { confirmPendingAction, invokeTool } from "../src/kernel/invoke.js";
import { InMemoryPendingStore } from "../src/db/pending-store.js";
import { createPrincipal } from "../src/kernel/rbac.js";
import { requiresConfirmation, PENDING_TTL_MS } from "../src/kernel/pending.js";
import type { TenantContext } from "../src/kernel/types.js";

const TENANT: TenantContext = {
  tenantId: "t1",
  schema: "tenant_t1",
  locale: "tr-TR",
  baseCurrency: "TRY",
};
const USER = "00000000-0000-0000-0000-0000000000aa";
const OTHER = "00000000-0000-0000-0000-0000000000bb";

/** Kaç kez gerçekten çalıştığını sayar — kapının sızdırıp sızdırmadığı budur. */
let runs: { qty: number }[] = [];

const writeTool = defineTool({
  name: "test_write",
  module: "sales",
  authority: 1,
  description: { tr: "Test yazma", en: "test write" },
  input: z.strictObject({ qty: z.number().positive() }),
  requires: [],
  async execute(input) {
    runs.push({ qty: input.qty });
    return {
      ok: true as const,
      data: { written: input.qty },
      sources: [{ system: "test", kind: "module" as const, syncedAt: "2026-06-15" }],
      confidence: 99,
    };
  },
});

const readTool = defineTool({
  name: "test_read",
  module: "sales",
  authority: 0,
  description: { tr: "Test okuma", en: "test read" },
  input: z.strictObject({}),
  requires: [],
  async execute() {
    runs.push({ qty: -1 });
    return {
      ok: true as const,
      data: { value: 1 },
      sources: [{ system: "test", kind: "module" as const, syncedAt: "2026-06-15" }],
      confidence: 99,
    };
  },
});

/** Yetki tavanı üstünde bir tool — operatör buna hiç ulaşamaz. */
const highTool = defineTool({
  name: "test_high",
  module: "sales",
  authority: 3,
  description: { tr: "Yüksek yetki", en: "high authority" },
  input: z.strictObject({}),
  requires: [],
  async execute() {
    runs.push({ qty: -3 });
    return {
      ok: true as const,
      data: {},
      sources: [{ system: "test", kind: "module" as const, syncedAt: "2026-06-15" }],
      confidence: 99,
    };
  },
});

/** Kendi onay akışını taşıyan tool — kapıdan muaf. */
const exemptTool = defineTool({
  name: "test_exempt",
  module: "sales",
  authority: 2,
  confirm: "never",
  description: { tr: "Muaf", en: "exempt" },
  input: z.strictObject({}),
  requires: [],
  async execute() {
    runs.push({ qty: -2 });
    return {
      ok: true as const,
      data: {},
      sources: [{ system: "test", kind: "module" as const, syncedAt: "2026-06-15" }],
      confidence: 99,
    };
  },
});

const registry = new ToolRegistry();
registry.register(
  writeTool as never,
  readTool as never,
  highTool as never,
  exemptTool as never,
);

const principal = createPrincipal({ userId: USER, tenantId: "t1", roles: ["patron"] });
const otherPrincipal = createPrincipal({ userId: OTHER, tenantId: "t1", roles: ["patron"] });

let pending: InMemoryPendingStore;
let audit: InMemoryAuditSink;

function opts(over: Partial<Parameters<typeof invokeTool>[2]> = {}) {
  return {
    registry,
    audit,
    principal,
    tenant: TENANT,
    correlationId: "c1",
    channel: "chat" as const,
    pending,
    ...over,
  };
}

beforeEach(() => {
  runs = [];
  pending = new InMemoryPendingStore();
  audit = new InMemoryAuditSink();
});

describe("hangi tool onay ister", () => {
  it("OKUMA ONAY İSTEMEZ — her sorguda onay, onayı anlamsızlaştırır", () => {
    expect(requiresConfirmation({ authority: 0 })).toBe(false);
  });

  it("YAZMANIN TAMAMI ONAY İSTER", () => {
    expect(requiresConfirmation({ authority: 1 })).toBe(true);
    expect(requiresConfirmation({ authority: 2 })).toBe(true);
    expect(requiresConfirmation({ authority: 3 })).toBe(true);
  });

  it("muafiyet AÇIKÇA yazılmalıdır", () => {
    expect(requiresConfirmation({ authority: 3, confirm: "never" })).toBe(false);
    expect(requiresConfirmation({ authority: 0, confirm: "always" })).toBe(true);
  });
});

describe("kapı", () => {
  it("YAZMA TOOL'U ONAYSIZ ÇALIŞMAZ", async () => {
    const r = await invokeTool("test_write", { qty: 5 }, opts());
    expect(r.outcome.ok).toBe(false);
    expect((r.outcome as { code: string }).code).toBe("confirmation_required");
    // Asıl iddia: hiçbir şey yazılmadı.
    expect(runs).toEqual([]);
  });

  it("okuma tool'u doğrudan çalışır", async () => {
    const r = await invokeTool("test_read", {}, opts());
    expect(r.outcome.ok).toBe(true);
    expect(runs).toHaveLength(1);
  });

  it("muaf tool doğrudan çalışır", async () => {
    const r = await invokeTool("test_exempt", {}, opts());
    expect(r.outcome.ok).toBe(true);
  });

  it("ONAY DEPOSU YOKSA YAZMA ÇALIŞMAZ — sessizce atlanmaz", async () => {
    // Yapılandırma eksikliği insan onayını devre dışı bırakmamalıdır.
    const { pending: _omit, ...withoutStore } = opts();
    const r = await invokeTool("test_write", { qty: 5 }, withoutStore);
    expect(r.outcome.ok).toBe(false);
    expect(runs).toEqual([]);
  });

  it("GEÇERSİZ GİRDİ ONAY BEKLEYEN İŞLEM OLUŞTURMAZ", async () => {
    const r = await invokeTool("test_write", { qty: -1 }, opts());
    expect((r.outcome as { code: string }).code).toBe("invalid_input");
    expect(await pending.listPending(USER, new Date())).toEqual([]);
  });

  it("YETKİ TAVANI AŞILIYORSA ONAY EKRANI DA AÇILMAZ", async () => {
    // Yetki reddi onaydan ÖNCE gelir: kullanıcıya asla yapamayacağı bir
    // işlemin formunu göstermek, "onaylarsam olur" izlenimi yaratır.
    const operator = createPrincipal({ userId: USER, tenantId: "t1", roles: ["operator"] });
    const r = await invokeTool("test_high", {}, opts({ principal: operator }));
    expect(r.outcome.ok).toBe(false);
    expect((r.outcome as { code: string }).code).not.toBe("confirmation_required");
    expect(await pending.listPending(USER, new Date())).toEqual([]);
  });

  it("denetime 'pending' olarak yazılır — başarı sayılmaz", async () => {
    await invokeTool("test_write", { qty: 5 }, opts());
    expect(audit.entries[0]!.outcome).toBe("pending");
  });
});

describe("onaylama", () => {
  async function prepare(qty = 5) {
    const r = await invokeTool("test_write", { qty }, opts());
    return (r.outcome as unknown as { pendingId: string }).pendingId;
  }

  it("onaylanan işlem çalışır", async () => {
    const id = await prepare(5);
    const r = await confirmPendingAction(id, undefined, opts());
    expect(r.outcome.ok).toBe(true);
    expect(runs).toEqual([{ qty: 5 }]);
  });

  it("GİRDİ ONAY ANINDA DÜZELTİLEBİLİR", async () => {
    const id = await prepare(5);
    await confirmPendingAction(id, { qty: 12 }, opts());
    expect(runs).toEqual([{ qty: 12 }]);
  });

  it("DÜZELTİLEN GİRDİ YENİDEN DOĞRULANIR", async () => {
    const id = await prepare(5);
    const r = await confirmPendingAction(id, { qty: -3 }, opts());
    expect(r.outcome.ok).toBe(false);
    expect(runs).toEqual([]);
  });

  it("AYNI İŞLEM İKİ KEZ ONAYLANAMAZ", async () => {
    const id = await prepare(5);
    await confirmPendingAction(id, undefined, opts());
    const second = await confirmPendingAction(id, undefined, opts());
    expect(second.outcome.ok).toBe(false);
    // İkinci kez çalışsaydı aynı fatura iki kez kesilirdi.
    expect(runs).toHaveLength(1);
  });

  it("EŞZAMANLI İKİ ONAY YALNIZCA BİR KEZ ÇALIŞTIRIR", async () => {
    const id = await prepare(5);
    await Promise.all([
      confirmPendingAction(id, undefined, opts()),
      confirmPendingAction(id, undefined, opts()),
    ]);
    expect(runs).toHaveLength(1);
  });

  it("BAŞKASININ HAZIRLADIĞI İŞLEM ONAYLANAMAZ", async () => {
    const id = await prepare(5);
    const r = await confirmPendingAction(id, undefined, opts({ principal: otherPrincipal }));
    expect(r.outcome.ok).toBe(false);
    expect((r.outcome as { code: string }).code).toBe("pending_not_found");
    expect(runs).toEqual([]);
  });

  it("SÜRESİ DOLMUŞ İŞLEM ÇALIŞMAZ", async () => {
    const id = await prepare(5);
    const later = new Date(Date.now() + PENDING_TTL_MS + 1000);
    const r = await confirmPendingAction(id, undefined, opts({ now: () => later }));
    expect(r.outcome.ok).toBe(false);
    expect(runs).toEqual([]);
  });

  it("İPTAL EDİLEN İŞLEM ONAYLANAMAZ", async () => {
    const id = await prepare(5);
    expect(await pending.cancel(id, USER)).toBe(true);
    const r = await confirmPendingAction(id, undefined, opts());
    expect(r.outcome.ok).toBe(false);
    expect(runs).toEqual([]);
  });

  it("BAŞKASI İPTAL EDEMEZ", async () => {
    const id = await prepare(5);
    expect(await pending.cancel(id, OTHER)).toBe(false);
  });

  it("olmayan işlem onaylanamaz", async () => {
    const r = await confirmPendingAction(
      "00000000-0000-0000-0000-00000000dead",
      undefined,
      opts(),
    );
    expect((r.outcome as { code: string }).code).toBe("pending_not_found");
  });

  it("İŞ KURALINA TAKILAN İŞLEM YENİDEN ONAYLANABİLİR", async () => {
    // Yazma gerçekleşmediyse kullanıcı bir alanı düzeltip tekrar
    // gönderebilmeli; formu baştan doldurmaya zorlanmamalı.
    const id = await prepare(5);
    const bad = await confirmPendingAction(id, { qty: -1 }, opts());
    expect(bad.outcome.ok).toBe(false);

    const good = await confirmPendingAction(id, { qty: 7 }, opts());
    expect(good.outcome.ok).toBe(true);
    expect(runs).toEqual([{ qty: 7 }]);
  });
});

describe("bekleyen liste", () => {
  it("kullanıcı yalnızca kendi bekleyenlerini görür", async () => {
    await invokeTool("test_write", { qty: 1 }, opts());
    await invokeTool("test_write", { qty: 2 }, opts({ principal: otherPrincipal }));
    expect(await pending.listPending(USER, new Date())).toHaveLength(1);
    expect(await pending.listPending(OTHER, new Date())).toHaveLength(1);
  });

  it("onaylanan liste dışına çıkar", async () => {
    const r = await invokeTool("test_write", { qty: 1 }, opts());
    const id = (r.outcome as unknown as { pendingId: string }).pendingId;
    await confirmPendingAction(id, undefined, opts());
    expect(await pending.listPending(USER, new Date())).toEqual([]);
  });

  it("SÜRESİ DOLAN SİLİNMEZ, İŞARETLENİR", async () => {
    // "Hazırladı ama onaylamadı" bilgisi denetimde anlamlıdır.
    const r = await invokeTool("test_write", { qty: 1 }, opts());
    const id = (r.outcome as unknown as { pendingId: string }).pendingId;
    const later = new Date(Date.now() + PENDING_TTL_MS + 1000);
    expect(await pending.expire(later)).toBe(1);
    expect(await pending.find(id, USER)).toMatchObject({ status: "expired" });
  });
});
