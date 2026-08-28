/**
 * Belge ve onay kalıcılığı — gerçek Postgres'e karşı.
 *
 * En önemli iddia: mükerrer fatura koruması VERİTABANI kısıtıyla kuruludur.
 * Uygulama kontrolü yarışa açıktır; burada iki eşzamanlı kaydın yalnızca
 * birinin geçtiği gerçek veritabanında gösterilir.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient as SharedPrisma } from "../src/db/generated/shared/index.js";
import { PrismaClient as TenantPrisma } from "../src/db/generated/tenant/index.js";
import { dropTenantSchema, provisionTenantSchema } from "../src/db/provision.js";
import { urlForSchema } from "../src/db/client.js";
import {
  PrismaApprovalRepository,
  PrismaDocumentsRepository,
} from "../src/db/documents-repository.js";
import { createPrincipal } from "../src/kernel/rbac.js";
import { matchInvoice, type Invoice } from "../src/modules/documents/three-way-match.js";
import {
  approve,
  createWorkspace,
  returnForCorrection,
  submitForReview,
} from "../src/modules/approval/workspace.js";

const SHARED_URL = process.env["SHARED_DATABASE_URL"];
const TENANT_URL = process.env["TENANT_DATABASE_URL"];
const enabled = Boolean(SHARED_URL && TENANT_URL);

const SCHEMA = "tenant_it_docs";
const T = SCHEMA;
const AT = "2026-05-16T09:00:00.000Z";
const HAZIRLAYAN = "33333333-3333-3333-3333-333333333333";
const ONAYLAYAN = "44444444-4444-4444-4444-444444444444";

const cfo = createPrincipal({
  userId: ONAYLAYAN,
  tenantId: T,
  roles: ["cfo"],
  approvalLimit: { amount: 5_000_000, currency: "TRY" },
});

function invoiceOf(id: string, documentNo: string, unitPrice: number): Invoice {
  return {
    id,
    partnerId: "p-burcelik",
    documentNo,
    issuedAt: AT,
    currency: "TRY",
    lines: [
      { lineNo: 1, poId: "PO-118", poLineNo: 1, itemId: "DINGIL-22310", quantity: 200, unitPrice, currency: "TRY" },
    ],
  };
}

describe.skipIf(!enabled)("belge ve onay kalıcılığı", () => {
  let shared: SharedPrisma;
  let db: TenantPrisma;
  let docs: PrismaDocumentsRepository;
  let approvals: PrismaApprovalRepository;

  beforeAll(async () => {
    shared = new SharedPrisma();
    await dropTenantSchema(shared, SCHEMA);
    await provisionTenantSchema(shared, SCHEMA);
    db = new TenantPrisma({ datasources: { db: { url: urlForSchema(TENANT_URL!, SCHEMA) } } });
    docs = new PrismaDocumentsRepository(db);
    approvals = new PrismaApprovalRepository(db);
  }, 60_000);

  afterAll(async () => {
    await db?.$disconnect();
    if (shared) {
      await dropTenantSchema(shared, SCHEMA);
      await shared.$disconnect();
    }
  });

  beforeEach(async () => {
    await db.approvalEvent.deleteMany();
    await db.approvalWorkspace.deleteMany();
    await db.invoiceFinding.deleteMany();
    await db.invoiceLine.deleteMany();
    await db.invoice.deleteMany();
    await db.goodsReceipt.deleteMany();
    await db.purchaseOrderLine.deleteMany();
    await db.purchaseOrder.deleteMany();

    await db.purchaseOrder.create({
      data: {
        id: "PO-118",
        partnerId: "p-burcelik",
        currency: "TRY",
        orderedAt: new Date(AT),
        lines: {
          create: [
            { lineNo: 1, itemId: "DINGIL-22310", quantity: 200, unitPrice: 1750, currency: "TRY" },
          ],
        },
      },
    });
    await db.goodsReceipt.create({
      data: { poId: "PO-118", poLineNo: 1, quantity: 200, receivedAt: new Date(AT) },
    });
  });

  // ─────────────────── mükerrer fatura ───────────────────

  it("MÜKERRER FATURA veritabanı kısıtıyla engellenir", async () => {
    await docs.createInvoice(T, invoiceOf("INV-A", "BRC-4892", 1750));
    await expect(
      docs.createInvoice(T, invoiceOf("INV-B", "BRC-4892", 1750)),
    ).rejects.toThrow(/zaten kayıtlı/);
    expect(await db.invoice.count()).toBe(1);
  });

  it("EŞZAMANLI mükerrer kayıt: uygulama kontrolü yarışsa bile yalnızca biri geçer", async () => {
    // Uygulama katmanı "daha önce var mı" diye baksaydı ikisi de 'yok' görürdü.
    // Kısıt bu yarışı kapatır.
    const results = await Promise.allSettled([
      docs.createInvoice(T, invoiceOf("INV-C1", "BRC-9999", 1750)),
      docs.createInvoice(T, invoiceOf("INV-C2", "BRC-9999", 1750)),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(await db.invoice.count()).toBe(1);
  });

  it("farklı tedarikçiden aynı belge numarası serbesttir", async () => {
    await docs.createInvoice(T, invoiceOf("INV-D1", "FTR-001", 1750));
    await docs.createInvoice(T, {
      ...invoiceOf("INV-D2", "FTR-001", 1750),
      partnerId: "p-baska",
    });
    expect(await db.invoice.count()).toBe(2);
  });

  // ─────────────────── eşleştirme kalıcılığı ───────────────────

  it("eşleştirme sonucu ve bulgular kalıcılaşır", async () => {
    await docs.createInvoice(T, invoiceOf("INV-E", "BRC-4892", 1870));
    const invoice = (await docs.getInvoice(T, "INV-E"))!;
    const [poLines, receipts] = await Promise.all([
      docs.poLinesFor(T, ["PO-118"]),
      docs.receiptsFor(T, ["PO-118"]),
    ]);
    const result = matchInvoice({ invoice, poLines, receipts });
    await docs.saveMatchResult(T, result);

    const row = await db.invoice.findUniqueOrThrow({
      where: { id: "INV-E" },
      include: { findings: true },
    });
    expect(row.matchStatus).toBe("blocked");
    expect(Number(row.totalVariance)).toBe(24_000);
    expect(row.findings).toHaveLength(1);
    expect(row.findings[0]?.reason).toBe("price_variance");
    expect(Number(row.findings[0]?.impact)).toBe(24_000);
  });

  it("tekrar eşleştirme bulguları çoğaltmaz", async () => {
    await docs.createInvoice(T, invoiceOf("INV-F", "BRC-4893", 1870));
    const invoice = (await docs.getInvoice(T, "INV-F"))!;
    const poLines = await docs.poLinesFor(T, ["PO-118"]);
    const receipts = await docs.receiptsFor(T, ["PO-118"]);
    const result = matchInvoice({ invoice, poLines, receipts });
    await docs.saveMatchResult(T, result);
    await docs.saveMatchResult(T, result);
    expect(await db.invoiceFinding.count({ where: { invoiceId: "INV-F" } })).toBe(1);
  });

  it("bloklanan faturalar en büyük bulguyla listelenir", async () => {
    await docs.createInvoice(T, invoiceOf("INV-G", "BRC-4894", 1870));
    const invoice = (await docs.getInvoice(T, "INV-G"))!;
    await docs.saveMatchResult(
      T,
      matchInvoice({
        invoice,
        poLines: await docs.poLinesFor(T, ["PO-118"]),
        receipts: await docs.receiptsFor(T, ["PO-118"]),
      }),
    );
    const rows = await docs.listByMatchStatus(T, "blocked");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.totalVariance).toBe(24_000);
    expect(rows[0]?.topFinding).toContain("%6.86");
  });

  // ─────────────────── onay kalıcılığı ───────────────────

  function ws() {
    return createWorkspace({
      id: "AW-1",
      kind: "invoice_acceptance",
      title: "Burçelik fatura kabulü",
      preparedBy: HAZIRLAYAN,
      amount: { amount: 374_000, currency: "TRY" },
      requiredPermission: "approval:finance.submit",
      payload: { invoiceId: "INV-E" },
      risks: ["%6,86 fiyat sapması"],
      at: AT,
    });
  }

  it("onay kaydı ve geçmişi tur atıp aynı sırayla döner", async () => {
    await approvals.create(T, ws());
    await approvals.mutate(T, "AW-1", (w) =>
      submitForReview(w, { principal: cfo, channel: "chat", at: AT }),
    );
    await approvals.mutate(T, "AW-1", (w) =>
      returnForCorrection(w, {
        principal: cfo,
        channel: "chat",
        at: AT,
        reason: "Tedarikçiden yazılı onay isteyin",
      }),
    );

    const loaded = (await approvals.get(T, "AW-1"))!;
    expect(loaded.state).toBe("returned_for_correction");
    expect(loaded.amount).toEqual({ amount: 374_000, currency: "TRY" });
    expect(loaded.risks).toEqual(["%6,86 fiyat sapması"]);
    expect(loaded.history.map((h) => h.to)).toEqual([
      "preparing",
      "ready_for_review",
      "returned_for_correction",
    ]);
    expect(loaded.history.at(-1)?.note).toContain("yazılı onay");
  });

  it("GEÇMİŞ APPEND-ONLY: mutasyon eski olayları yeniden yazmaz", async () => {
    await approvals.create(T, ws());
    await approvals.mutate(T, "AW-1", (w) =>
      submitForReview(w, { principal: cfo, channel: "chat", at: AT }),
    );
    const first = await db.approvalEvent.findFirstOrThrow({
      where: { workspaceId: "AW-1", seq: 0 },
    });

    await approvals.mutate(T, "AW-1", (w) =>
      approve(w, { principal: cfo, channel: "chat", at: AT, risksAcknowledged: true }),
    );

    const stillFirst = await db.approvalEvent.findFirstOrThrow({
      where: { workspaceId: "AW-1", seq: 0 },
    });
    expect(stillFirst.id).toBe(first.id);
    expect(await db.approvalEvent.count({ where: { workspaceId: "AW-1" } })).toBe(3);
  });

  it("hazırlayan onaylayamaz — kalıcılık katmanından yüklenen kayıtta da", async () => {
    const hazirlayan = createPrincipal({
      userId: HAZIRLAYAN,
      tenantId: T,
      roles: ["cfo"],
      approvalLimit: { amount: 5_000_000, currency: "TRY" },
    });
    await approvals.create(T, ws());
    await approvals.mutate(T, "AW-1", (w) =>
      submitForReview(w, { principal: cfo, channel: "chat", at: AT }),
    );
    await expect(
      approvals.mutate(T, "AW-1", (w) =>
        approve(w, { principal: hazirlayan, channel: "chat", at: AT, risksAcknowledged: true }),
      ),
    ).rejects.toThrow(/hazırlayan kişi onaylayamaz/);
    // Reddedilen mutasyon durumu değiştirmemeli
    expect((await approvals.get(T, "AW-1"))!.state).toBe("ready_for_review");
  });

  it("EŞZAMANLI ONAY: iyimser kilit ikinciyi reddeder", async () => {
    await approvals.create(T, ws());
    await approvals.mutate(T, "AW-1", (w) =>
      submitForReview(w, { principal: cfo, channel: "chat", at: AT }),
    );

    const ikinciOnaylayan = createPrincipal({
      userId: "55555555-5555-5555-5555-555555555555",
      tenantId: T,
      roles: ["cfo"],
      approvalLimit: { amount: 5_000_000, currency: "TRY" },
    });

    const results = await Promise.allSettled([
      approvals.mutate(T, "AW-1", (w) =>
        approve(w, { principal: cfo, channel: "chat", at: AT, risksAcknowledged: true }),
      ),
      approvals.mutate(T, "AW-1", (w) =>
        approve(w, { principal: ikinciOnaylayan, channel: "chat", at: AT, risksAcknowledged: true }),
      ),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);

    const loaded = (await approvals.get(T, "AW-1"))!;
    expect(loaded.state).toBe("approved");
    // Tek onay olayı yazılmış olmalı
    expect(loaded.history.filter((h) => h.to === "approved")).toHaveLength(1);
  });

  it("duruma göre listeleme çalışır", async () => {
    await approvals.create(T, ws());
    expect(await approvals.listByState(T, "preparing")).toHaveLength(1);
    expect(await approvals.listByState(T, "approved")).toHaveLength(0);
    expect(await approvals.listByState(T, null)).toHaveLength(1);
  });
});
