/**
 * Üretim tool'ları — uçtan uca, invoker üzerinden.
 *
 * Buradaki testler alan mantığını değil, TOOL SÖZLEŞMESİNİ doğrular:
 * doğru yetki isteniyor mu, kural ihlali kullanıcıya anlamlı gerekçeyle
 * dönüyor mu, ve eşzamanlı çağrılarda değişmez kırılıyor mu.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { buildRegistry } from "../src/app.js";
import { InMemoryDataSource } from "../src/data/memory.js";
import { InMemoryAuditSink } from "../src/kernel/audit.js";
import { invokeTool } from "../src/kernel/invoke.js";
import { createPrincipal } from "../src/kernel/rbac.js";
import type { TenantContext } from "../src/kernel/types.js";
import { InMemoryOperationsRepository } from "../src/modules/operations/repository.js";
import { createWorkOrder, type RoutingOperation } from "../src/modules/operations/work-order.js";

const TENANT: TenantContext = {
  tenantId: "t1",
  schema: "tenant_t1",
  locale: "tr-TR",
  baseCurrency: "TRY",
};

const patron = createPrincipal({ userId: "u-patron", tenantId: "t1", roles: ["patron"] });
const uretim = createPrincipal({ userId: "u-uretim", tenantId: "t1", roles: ["uretim_muduru"] });
const operator = createPrincipal({ userId: "u-op", tenantId: "t1", roles: ["operator"] });
const depo = createPrincipal({ userId: "u-depo", tenantId: "t1", roles: ["depo_sorumlusu"] });

const ROUTING: readonly RoutingOperation[] = [
  { seq: 10, workCenter: "KESIM", description: "Kesim", gate: null },
  {
    seq: 20,
    workCenter: "KAYNAK",
    description: "Kaynak",
    gate: { characteristic: "Kaynak penetrasyonu", decidedBy: "quality:gate.release" },
  },
  { seq: 30, workCenter: "BOYA", description: "Boya", gate: null },
];

let repo: InMemoryOperationsRepository;
let audit: InMemoryAuditSink;

beforeEach(async () => {
  repo = new InMemoryOperationsRepository({ bomRevisions: { "FR-22": "R3" } });
  audit = new InMemoryAuditSink();
  await repo.saveWorkOrder(
    "t1",
    createWorkOrder({ id: "WO-1", itemId: "FR-22", quantity: 10, routing: ROUTING }),
  );
});

function call(tool: string, input: unknown, principal = uretim) {
  return invokeTool(tool, input, {
    registry: buildRegistry(new InMemoryDataSource(), { operations: repo }),
    audit,
    principal,
    tenant: TENANT,
    correlationId: "c1",
    channel: "chat",
    now: () => new Date("2026-05-16T08:00:00.000Z"),
  });
}

describe("görevler ayrılığı — kalite override", () => {
  it("üretim müdürü kalite KARARI verebilir", () => {
    const registry = buildRegistry(new InMemoryDataSource(), { operations: repo });
    expect(registry.catalogFor(uretim).names).toContain("record_quality_decision");
  });

  it("üretim müdürü kalite kapısını ATLAYAMAZ — tool listesinde yok", () => {
    const registry = buildRegistry(new InMemoryDataSource(), { operations: repo });
    expect(registry.catalogFor(uretim).names).not.toContain("override_quality_gate");
  });

  it("patron atlayabilir", () => {
    const registry = buildRegistry(new InMemoryDataSource(), { operations: repo });
    expect(registry.catalogFor(patron).names).toContain("override_quality_gate");
  });

  it("üretim müdürü zorlasa da invoker reddeder", async () => {
    const res = await call("override_quality_gate", {
      workOrderId: "WO-1",
      seq: 20,
      reason: "Sevkiyat kritik, riski alıyorum",
    });
    expect(res.outcome.ok).toBe(false);
    if (!res.outcome.ok) expect(res.outcome.code).toBe("permission_denied");
  });
});

describe("kalite kapısı tool katmanında da atlanamaz", () => {
  async function upToGate() {
    await call("release_work_order", { workOrderId: "WO-1", requestedRevision: null, reason: null });
    await call("start_operation", { workOrderId: "WO-1", seq: 10 });
    await call("confirm_operation", { workOrderId: "WO-1", seq: 10, confirmedQty: 10, scrapQty: 0 });
    await call("start_operation", { workOrderId: "WO-1", seq: 20 });
    await call("confirm_operation", { workOrderId: "WO-1", seq: 20, confirmedQty: 10, scrapQty: 0 });
  }

  it("kapı beklerken sonraki operasyon reddedilir ve GERÇEK neden döner", async () => {
    await upToGate();
    const res = await call("start_operation", { workOrderId: "WO-1", seq: 30 });
    expect(res.outcome.ok).toBe(false);
    if (!res.outcome.ok) {
      expect(res.outcome.code).toBe("business_rule");
      // Model kullanıcıya gerçek nedeni söyleyebilmeli — genel hata değil.
      expect(res.outcome.userFacing).toBe(true);
      expect(res.outcome.message).toContain("kalite kapısında bekliyor");
    }
  });

  it("PASS sonrası açılır", async () => {
    await upToGate();
    const pass = await call("record_quality_decision", {
      workOrderId: "WO-1",
      seq: 20,
      decision: "pass",
      measurement: null,
      reason: null,
    });
    expect(pass.outcome.ok).toBe(true);
    const res = await call("start_operation", { workOrderId: "WO-1", seq: 30 });
    expect(res.outcome.ok).toBe(true);
  });

  it("operatör kalite kararı veremez", async () => {
    await upToGate();
    const res = await call(
      "record_quality_decision",
      { workOrderId: "WO-1", seq: 20, decision: "pass", measurement: null, reason: null },
      operator,
    );
    expect(res.outcome.ok).toBe(false);
    if (!res.outcome.ok) expect(res.outcome.code).toBe("permission_denied");
  });
});

describe("BOM revizyonu", () => {
  it("serbest bırakma aktif revizyonu dondurur", async () => {
    const res = await call("release_work_order", {
      workOrderId: "WO-1",
      requestedRevision: null,
      reason: null,
    });
    expect(res.outcome.ok).toBe(true);
    if (res.outcome.ok) {
      expect((res.outcome.data as { bomRevision: string }).bomRevision).toBe("R3");
    }
  });

  it("eski revizyon gerekçesiz reddedilir", async () => {
    const res = await call("release_work_order", {
      workOrderId: "WO-1",
      requestedRevision: "R2",
      reason: null,
    });
    expect(res.outcome.ok).toBe(false);
    if (!res.outcome.ok) expect(res.outcome.message).toContain("gerekçe zorunludur");
  });

  it("eski revizyon gerekçeyle kabul edilir ve risk işaretlenir", async () => {
    const res = await call("release_work_order", {
      workOrderId: "WO-1",
      requestedRevision: "R2",
      reason: "Volvo sözleşmesi R2 şartnamesine bağlı",
    });
    expect(res.outcome.ok).toBe(true);
    if (res.outcome.ok) {
      expect(res.outcome.risks?.[0]?.message).toContain("Aktif olmayan BOM revizyonu");
    }
  });
});

describe("stok tool'ları", () => {
  it("mal kabul bakiyeyi artırır ve yeni bakiyeyi döner", async () => {
    const res = await call(
      "post_stock_movement",
      {
        movementType: "101",
        itemId: "DINGIL",
        locationId: "DEPO-01",
        batchId: null,
        quantity: 200,
        referenceKind: "purchase_order",
        referenceId: "PO-77",
        reason: null,
      },
      depo,
    );
    expect(res.outcome.ok).toBe(true);
    if (res.outcome.ok) {
      expect((res.outcome.data as { newBalance: number }).newBalance).toBe(200);
    }
  });

  it("negatif stoğa yol açan sarf reddedilir, gerekçesi kullanıcıya döner", async () => {
    await call(
      "post_stock_movement",
      {
        movementType: "101", itemId: "DINGIL", locationId: "DEPO-01", batchId: null,
        quantity: 50, referenceKind: "purchase_order", referenceId: "PO-77", reason: null,
      },
      depo,
    );
    const res = await call(
      "post_stock_movement",
      {
        movementType: "261", itemId: "DINGIL", locationId: "DEPO-01", batchId: null,
        quantity: 80, referenceKind: "work_order", referenceId: "WO-1", reason: null,
      },
      depo,
    );
    expect(res.outcome.ok).toBe(false);
    if (!res.outcome.ok) {
      expect(res.outcome.userFacing).toBe(true);
      expect(res.outcome.message).toContain("negatife düşürür");
    }
  });

  it("depo sorumlusu sayım düzeltmesi YAPAMAZ", async () => {
    const registry = buildRegistry(new InMemoryDataSource(), { operations: repo });
    expect(registry.catalogFor(depo).names).not.toContain("post_stock_correction");
  });

  it("üretim müdürü gerekçeli sayım farkı kaydedebilir", async () => {
    await call(
      "post_stock_movement",
      {
        movementType: "101", itemId: "DINGIL", locationId: "DEPO-01", batchId: null,
        quantity: 100, referenceKind: "purchase_order", referenceId: "PO-1", reason: null,
      },
      depo,
    );
    const res = await call("post_stock_correction", {
      direction: "702",
      itemId: "DINGIL",
      locationId: "DEPO-01",
      batchId: null,
      quantity: 5,
      countId: "SAY-2026-03",
      reason: "Raf 3B sayımında 5 adet eksik çıktı",
    });
    expect(res.outcome.ok).toBe(true);
    if (res.outcome.ok) {
      expect(res.outcome.risks?.[0]?.message).toContain("stok doğruluk skorunu");
    }
  });

  it("iptal silme değildir — defterde iki kayıt kalır", async () => {
    const gr = await call(
      "post_stock_movement",
      {
        movementType: "101", itemId: "DINGIL", locationId: "DEPO-01", batchId: null,
        quantity: 100, referenceKind: "purchase_order", referenceId: "PO-1", reason: null,
      },
      depo,
    );
    const id = (gr.outcome as { ok: true; data: { movement: { id: string } } }).data.movement.id;

    const rev = await call("reverse_stock_movement", {
      originalMovementId: id,
      reversalType: "102",
      quantity: 100,
      reason: "Yanlış kalem okundu, irsaliye farklı",
    });
    expect(rev.outcome.ok).toBe(true);
    expect(repo.ledger).toHaveLength(2);
    expect(await repo.balance("t1", { itemId: "DINGIL", locationId: "DEPO-01", batchId: null })).toBe(0);
  });
});

describe("eşzamanlılık — değişmez kilit altında", () => {
  it("aynı anda iki sarf, stoğu negatife düşüremez", async () => {
    await call(
      "post_stock_movement",
      {
        movementType: "101", itemId: "DINGIL", locationId: "DEPO-01", batchId: null,
        quantity: 10, referenceKind: "purchase_order", referenceId: "PO-1", reason: null,
      },
      depo,
    );

    // İki operatör aynı anda son 10 adedin 8'erini sarf etmeye çalışıyor.
    // Kilit olmasaydı ikisi de "yeterli" görür, bakiye −6'ya düşerdi.
    const [a, b] = await Promise.all([
      call(
        "post_stock_movement",
        {
          movementType: "261", itemId: "DINGIL", locationId: "DEPO-01", batchId: null,
          quantity: 8, referenceKind: "work_order", referenceId: "WO-1", reason: null,
        },
        depo,
      ),
      call(
        "post_stock_movement",
        {
          movementType: "261", itemId: "DINGIL", locationId: "DEPO-01", batchId: null,
          quantity: 8, referenceKind: "work_order", referenceId: "WO-1", reason: null,
        },
        depo,
      ),
    ]);

    const succeeded = [a, b].filter((r) => r.outcome.ok).length;
    expect(succeeded).toBe(1);
    const balance = await repo.balance("t1", {
      itemId: "DINGIL",
      locationId: "DEPO-01",
      batchId: null,
    });
    expect(balance).toBe(2);
    expect(balance).toBeGreaterThanOrEqual(0);
  });
});

describe("audit", () => {
  it("her tool çağrısı — reddedilenler dahil — kayda düşer", async () => {
    await call("get_work_order", { workOrderId: "WO-1" });
    await call("override_quality_gate", { workOrderId: "WO-1", seq: 20, reason: "denedim ama yetkim yok" });
    expect(audit.entries).toHaveLength(2);
    expect(audit.entries[0]?.outcome).toBe("success");
    expect(audit.entries[1]?.outcome).toBe("denied");
    expect(audit.entries[1]?.toolName).toBe("override_quality_gate");
  });
});
