/**
 * Fatura → eşleştirme → onay zinciri, invoker üzerinden uçtan uca.
 *
 * Dokümandaki Burçelik senaryosunun tam akışı: fatura gelir, eşleştirme
 * sapmayı yakalar, onay kaydı açılır, hazırlayan onaylayamaz, yetkili
 * riskleri teyit ederek onaylar — ve onay GÖNDERİM DEĞİLDİR.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { buildRegistry } from "../src/app.js";
import { InMemoryDataSource } from "../src/data/memory.js";
import { InMemoryAuditSink } from "../src/kernel/audit.js";
import { invokeTool } from "../src/kernel/invoke.js";
import { createPrincipal } from "../src/kernel/rbac.js";
import type { Channel, TenantContext } from "../src/kernel/types.js";
import {
  InMemoryApprovalRepository,
  InMemoryDocumentsRepository,
} from "../src/modules/documents/repository.js";
import type {
  GoodsReceiptLine,
  Invoice,
  PurchaseOrderLine,
} from "../src/modules/documents/three-way-match.js";

const TENANT: TenantContext = { tenantId: "t1", schema: "tenant_t1", locale: "tr-TR", baseCurrency: "TRY" };
const NOW = () => new Date("2026-05-16T09:00:00.000Z");

const satinAlma = createPrincipal({ userId: "u-sa", tenantId: "t1", roles: ["satin_alma"] });
const cfo = createPrincipal({
  userId: "u-cfo",
  tenantId: "t1",
  roles: ["cfo"],
  approvalLimit: { amount: 1_000_000, currency: "TRY" },
});
const depo = createPrincipal({ userId: "u-depo", tenantId: "t1", roles: ["depo_sorumlusu"] });

const PO: readonly PurchaseOrderLine[] = [
  { poId: "PO-118", lineNo: 1, itemId: "DINGIL-22310", quantity: 200, unitPrice: 1750, currency: "TRY" },
];
const GR: readonly GoodsReceiptLine[] = [
  { grId: "GR-1", poId: "PO-118", poLineNo: 1, quantity: 200, receivedAt: "2026-05-10T00:00:00.000Z" },
];
const SAPMALI: Invoice = {
  id: "INV-4892",
  partnerId: "p-burcelik",
  documentNo: "BRC-2026-4892",
  issuedAt: "2026-05-15T00:00:00.000Z",
  currency: "TRY",
  lines: [
    { lineNo: 1, poId: "PO-118", poLineNo: 1, itemId: "DINGIL-22310", quantity: 200, unitPrice: 1870, currency: "TRY" },
  ],
};
const TEMIZ: Invoice = {
  ...SAPMALI,
  id: "INV-4893",
  documentNo: "BRC-2026-4893",
  lines: [
    { lineNo: 1, poId: "PO-118", poLineNo: 1, itemId: "DINGIL-22310", quantity: 200, unitPrice: 1750, currency: "TRY" },
  ],
};

let docs: InMemoryDocumentsRepository;
let approvals: InMemoryApprovalRepository;
let audit: InMemoryAuditSink;

beforeEach(() => {
  docs = new InMemoryDocumentsRepository({ invoices: [SAPMALI, TEMIZ], poLines: PO, receipts: GR });
  approvals = new InMemoryApprovalRepository();
  audit = new InMemoryAuditSink();
});

function call(tool: string, input: unknown, principal = satinAlma, channel: Channel = "chat") {
  return invokeTool(tool, input, {
    registry: buildRegistry(new InMemoryDataSource(), { documents: docs, approvals }),
    audit,
    principal,
    tenant: TENANT,
    correlationId: "c1",
    channel,
    now: NOW,
  });
}

describe("eşleştirme tool'u", () => {
  it("BURÇELİK: sapma yakalanır, risk olarak modele iletilir", async () => {
    const res = await call("match_invoice", { invoiceId: "INV-4892" });
    expect(res.outcome.ok).toBe(true);
    if (res.outcome.ok) {
      const data = res.outcome.data as { status: string; totalVariance: number };
      expect(data.status).toBe("blocked");
      expect(data.totalVariance).toBe(24_000);
      expect(res.outcome.risks?.[0]?.message).toContain("%6.86");
      // Üç kaynak birden gösterilir: fatura, sipariş, mal kabul
      expect(res.outcome.sources).toHaveLength(3);
      expect(res.outcome.confidence).toBeLessThan(100);
    }
  });

  it("temiz fatura eşleşir ve güven 100 olur", async () => {
    const res = await call("match_invoice", { invoiceId: "INV-4893" });
    if (res.outcome.ok) {
      expect((res.outcome.data as { status: string }).status).toBe("matched");
      expect(res.outcome.confidence).toBe(100);
    }
  });

  it("olmayan fatura için uydurma yapmaz", async () => {
    const res = await call("match_invoice", { invoiceId: "YOK" });
    expect(res.outcome.ok).toBe(true);
    if (res.outcome.ok) {
      expect(res.outcome.data).toBeNull();
      expect(res.outcome.risks?.[0]?.message).toContain("Uydurma sonuç verme");
    }
  });

  it("depo sorumlusu fatura eşleştiremez", async () => {
    const registry = buildRegistry(new InMemoryDataSource(), { documents: docs, approvals });
    expect(registry.catalogFor(depo).names).not.toContain("match_invoice");
  });

  it("bloklanan faturalar listelenir ve toplam sapma verilir", async () => {
    await call("match_invoice", { invoiceId: "INV-4892" });
    await call("match_invoice", { invoiceId: "INV-4893" });
    const res = await call("list_blocked_invoices", { status: "blocked" });
    if (res.outcome.ok) {
      const rows = res.outcome.data as { documentNo: string }[];
      expect(rows).toHaveLength(1);
      expect(rows[0]?.documentNo).toBe("BRC-2026-4892");
      expect(res.outcome.risks?.[0]?.message).toContain("1 fatura bloklanmış");
    }
  });
});

describe("onay zinciri — uçtan uca", () => {
  async function opened() {
    return call("open_approval_for_invoice", {
      invoiceId: "INV-4892",
      title: "Burçelik BRC-2026-4892 fiyat sapması",
    });
  }

  it("onay kaydı açılır, bulgular risk olarak taşınır, incelemeye gider", async () => {
    const res = await opened();
    expect(res.outcome.ok).toBe(true);
    if (res.outcome.ok) {
      const ws = res.outcome.data as { state: string; risks: string[]; pendingOn: string };
      expect(ws.state).toBe("ready_for_review");
      expect(ws.risks[0]).toContain("%6.86");
      expect(ws.pendingOn).toContain("hazırlayan dışında");
    }
  });

  it("HAZIRLAYAN ONAYLAYAMAZ — satın alma kendi açtığını onaylayamaz", async () => {
    await opened();
    const res = await call(
      "approve_document",
      { approvalId: "AW-INV-4892", risksAcknowledged: true, note: null },
      satinAlma,
    );
    expect(res.outcome.ok).toBe(false);
    if (!res.outcome.ok) {
      expect(res.outcome.userFacing).toBe(true);
      expect(res.outcome.message).toContain("hazırlayan kişi onaylayamaz");
    }
  });

  it("RİSKLER TEYİT EDİLMEDEN onaylanamaz", async () => {
    await opened();
    const res = await call(
      "approve_document",
      { approvalId: "AW-INV-4892", risksAcknowledged: false, note: null },
      cfo,
    );
    expect(res.outcome.ok).toBe(false);
    if (!res.outcome.ok) expect(res.outcome.message).toContain("riskler açıkça teyit");
  });

  it("yetkili riskleri teyit ederek onaylar — ve ONAY GÖNDERİM DEĞİLDİR", async () => {
    await opened();
    const res = await call(
      "approve_document",
      { approvalId: "AW-INV-4892", risksAcknowledged: true, note: "Tedarikçiyle görüşüldü, fark kabul" },
      cfo,
    );
    expect(res.outcome.ok).toBe(true);
    if (res.outcome.ok) {
      const ws = res.outcome.data as { state: string; approvedBy: string; pendingOn: string };
      expect(ws.state).toBe("approved");
      expect(ws.approvedBy).toBe("u-cfo");
      expect(ws.pendingOn).toContain("KAELON göndermez");
      expect(res.outcome.risks?.[0]?.message).toContain("KAELON tarafından YAPILMAZ");
    }
  });

  it("onay limiti aşılırsa reddedilir", async () => {
    const kucukLimit = createPrincipal({
      userId: "u-cfo3",
      tenantId: "t1",
      roles: ["cfo"],
      approvalLimit: { amount: 100_000, currency: "TRY" },
    });
    await opened();
    const res = await call(
      "approve_document",
      { approvalId: "AW-INV-4892", risksAcknowledged: true, note: null },
      kucukLimit,
    );
    expect(res.outcome.ok).toBe(false);
    if (!res.outcome.ok) expect(res.outcome.message).toContain("eskale");
  });

  it("düzeltmeye geri gönderilir ve gerekçe kalıcı olur", async () => {
    await opened();
    const res = await call(
      "return_for_correction",
      { approvalId: "AW-INV-4892", reason: "Tedarikçiden fiyat farkı için yazılı onay isteyin" },
      cfo,
    );
    expect(res.outcome.ok).toBe(true);
    const ws = await approvals.get("t1", "AW-INV-4892");
    expect(ws?.state).toBe("returned_for_correction");
    expect(ws?.history.at(-1)?.note).toContain("yazılı onay");
  });

  it("düzeltme gerekçesiz istenemez — şema seviyesinde reddedilir", async () => {
    await opened();
    const res = await call("return_for_correction", { approvalId: "AW-INV-4892", reason: "kısa" }, cfo);
    expect(res.outcome.ok).toBe(false);
    if (!res.outcome.ok) expect(res.outcome.code).toBe("invalid_input");
  });

  it("bekleyen onaylar listelenir", async () => {
    await opened();
    const res = await call("list_pending_approvals", { state: "ready_for_review" }, cfo);
    if (res.outcome.ok) {
      expect((res.outcome.data as unknown[]).length).toBe(1);
    }
  });

  it("her adım audit'e düşer — reddedilen onay denemesi dahil", async () => {
    await opened();
    await call("approve_document", { approvalId: "AW-INV-4892", risksAcknowledged: true, note: null }, satinAlma);
    const names = audit.entries.map((e) => `${e.toolName}:${e.outcome}`);
    expect(names).toContain("open_approval_for_invoice:success");
    expect(names).toContain("approve_document:failed");
  });
});

describe("görev ayrılığı izin seviyesinde de kurulu", () => {
  it("satın alma onay AÇABİLİR ama finans onayı VEREMEZ", () => {
    expect(satinAlma.permissions.has("approval:procurement.submit")).toBe(true);
    expect(satinAlma.permissions.has("approval:finance.submit")).toBe(false);
  });

  it("CFO finans onayı verebilir", () => {
    expect(cfo.permissions.has("approval:finance.submit")).toBe(true);
  });
});
