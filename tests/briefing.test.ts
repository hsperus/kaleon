/**
 * Boss Mode testleri.
 *
 * En önemli iddia: ekranın doluluğu bir tasarım tercihi DEĞİL, eşik
 * fonksiyonunun çıktısıdır. Aynı kod, farklı veriyle farklı seviye üretir;
 * ve aynı veri, farklı eşiklerle farklı seviye üretir.
 */

import { describe, expect, it } from "vitest";
import { buildBriefing } from "../src/modules/briefing/engine.js";
import {
  DEFAULT_THRESHOLDS,
  SENTINELS,
  levelForAmount,
  type Sentinel,
} from "../src/modules/briefing/sentinels.js";
import { buildRegistry } from "../src/app.js";
import { InMemoryDataSource } from "../src/data/memory.js";
import { InMemoryAuditSink } from "../src/kernel/audit.js";
import { createPrincipal } from "../src/kernel/rbac.js";
import type { TenantContext } from "../src/kernel/types.js";

const TENANT: TenantContext = { tenantId: "t1", schema: "tenant_t1", locale: "tr-TR", baseCurrency: "TRY" };

function run(role: "patron" | "cfo" | "depo_sorumlusu" | "uretim_muduru", over?: Partial<typeof DEFAULT_THRESHOLDS>) {
  return buildBriefing(
    {
      registry: buildRegistry(new InMemoryDataSource()),
      audit: new InMemoryAuditSink(),
      ...(over ? { thresholds: { ...DEFAULT_THRESHOLDS, ...over } } : {}),
    },
    {
      principal: createPrincipal({ userId: "u1", tenantId: "t1", roles: [role] }),
      tenant: TENANT,
      correlationId: "c1",
      channel: "job",
      now: () => new Date("2026-05-16T07:00:00.000Z"),
    },
  );
}

describe("seviye bir EŞİK fonksiyonudur", () => {
  it("eşik altı tutar seviye üretmez", () => {
    expect(levelForAmount(10_000, DEFAULT_THRESHOLDS)).toBe(0);
  });
  it("dikkat eşiği seviye 1", () => {
    expect(levelForAmount(50_000, DEFAULT_THRESHOLDS)).toBe(1);
  });
  it("zarar eşiği seviye 2", () => {
    expect(levelForAmount(156_000, DEFAULT_THRESHOLDS)).toBe(2);
  });
  it("işaret önemsiz — eksi sapma da etkidir", () => {
    expect(levelForAmount(-156_000, DEFAULT_THRESHOLDS)).toBe(2);
  });
});

describe("aynı veri, farklı eşik → farklı ekran", () => {
  it("varsayılan eşikle sevkiyat riski KRİTİK", async () => {
    const b = await run("patron");
    const s = b.signals.find((x) => x.id === "shipment_delay");
    expect(s?.level).toBe(2);
    expect(s?.impact).toBe(156_000);
    expect(b.level).toBe(2);
  });

  it("eşikler yükseltilirse aynı veri SESSİZ kalır", async () => {
    const b = await run("patron", { noticeAmount: 500_000, criticalAmount: 2_000_000 });
    expect(b.signals.find((x) => x.id === "shipment_delay")).toBeUndefined();
  });

  it("büyük fabrikada 156.000 TL yuvarlama, küçük fabrikada kriz", async () => {
    const buyuk = await run("patron", { noticeAmount: 1_000_000, criticalAmount: 5_000_000 });
    const kucuk = await run("patron", { noticeAmount: 5_000, criticalAmount: 20_000 });
    const b1 = buyuk.signals.find((x) => x.id === "shipment_delay");
    const b2 = kucuk.signals.find((x) => x.id === "shipment_delay");
    expect(b1).toBeUndefined();
    expect(b2?.level).toBe(2);
  });
});

describe("PROAKTİFLİK ROLE BAĞLIDIR", () => {
  it("depo sorumlusuna sevkiyat ve fatura nöbetçisi HİÇ koşmaz", async () => {
    const b = await run("depo_sorumlusu");
    expect(b.skippedByPermission).toContain("blocked_invoices");
    expect(b.skippedByPermission).toContain("pending_approvals");
    expect(b.signals.every((s) => s.id !== "blocked_invoices")).toBe(true);
  });

  it("patron tüm nöbetçileri alır", async () => {
    const b = await run("patron");
    expect(b.skippedByPermission).toHaveLength(0);
    expect(b.ran).toBe(SENTINELS.length);
  });

  it("üretim müdürü üretim sinyallerini alır, onay bekleyenleri de görür", async () => {
    const b = await run("uretim_muduru");
    expect(b.signals.some((s) => s.id === "bottleneck")).toBe(true);
  });

  it("CFO üretim hızı uyarısı ALMAZ — rolünün alanı değil", async () => {
    const b = await run("cfo");
    expect(b.skippedByPermission).toContain("production");
    expect(b.signals.every((s) => s.id !== "production_rate")).toBe(true);
  });
});

describe("sinyal sıralaması ve dayanıklılık", () => {
  it("kritik sinyaller önce, sonra parasal etkiye göre", async () => {
    const b = await run("patron");
    for (let i = 1; i < b.signals.length; i++) {
      expect(b.signals[i - 1]!.level).toBeGreaterThanOrEqual(b.signals[i]!.level);
    }
  });

  it("her sinyal drilldown taşır — kullanıcı kanıta inebilmeli", async () => {
    const b = await run("patron");
    expect(b.signals.length).toBeGreaterThan(0);
    for (const s of b.signals) expect(s.drilldown?.tool).toBeTruthy();
  });

  it("bir nöbetçi patlarsa brifing düşmez", async () => {
    const bozuk: Sentinel = {
      id: "bozuk",
      tool: "get_factory_wip",
      input: {},
      requires: "operations:workorder.read",
      evaluate() {
        throw new Error("nöbetçi patladı");
      },
    };
    const b = await buildBriefing(
      {
        registry: buildRegistry(new InMemoryDataSource()),
        audit: new InMemoryAuditSink(),
        sentinels: [bozuk, ...SENTINELS],
      },
      {
        principal: createPrincipal({ userId: "u", tenantId: "t1", roles: ["patron"] }),
        tenant: TENANT,
        correlationId: "c",
        channel: "job",
      },
    );
    expect(b.signals.length).toBeGreaterThan(0);
  });

  it("nöbetçiler NORMAL tool yolundan geçer — audit'e düşer", async () => {
    const audit = new InMemoryAuditSink();
    await buildBriefing(
      { registry: buildRegistry(new InMemoryDataSource()), audit },
      {
        principal: createPrincipal({ userId: "u", tenantId: "t1", roles: ["patron"] }),
        tenant: TENANT,
        correlationId: "c",
        channel: "job",
      },
    );
    expect(audit.entries.length).toBe(SENTINELS.length);
    expect(audit.entries.every((e) => e.channel === "job")).toBe(true);
  });
});
