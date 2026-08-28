/**
 * Üç yönlü eşleştirme ve onay akışı testleri.
 *
 * Burçelik senaryosu dokümandan alınmıştır: "Bu ay 3 faturada toplam %6,8
 * fiyat sapması." Bu tespiti üreten motor burasıdır.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_TOLERANCE,
  exceedsPriceTolerance,
  matchInvoice,
  type GoodsReceiptLine,
  type Invoice,
  type PurchaseOrderLine,
} from "../src/modules/documents/three-way-match.js";
import {
  approve,
  archive,
  createWorkspace,
  pendingOn,
  recordExternalResult,
  recordExternalSubmission,
  returnForCorrection,
  submitForReview,
} from "../src/modules/approval/workspace.js";
import { createPrincipal } from "../src/kernel/rbac.js";

const AT = "2026-05-16T09:00:00.000Z";

const PO: readonly PurchaseOrderLine[] = [
  { poId: "PO-2026-118", lineNo: 1, itemId: "DINGIL-22310", quantity: 200, unitPrice: 1750, currency: "TRY" },
  { poId: "PO-2026-118", lineNo: 2, itemId: "CIVATA-M12", quantity: 1000, unitPrice: 8, currency: "TRY" },
];

const GR: readonly GoodsReceiptLine[] = [
  { grId: "GR-1", poId: "PO-2026-118", poLineNo: 1, quantity: 200, receivedAt: AT },
  { grId: "GR-2", poId: "PO-2026-118", poLineNo: 2, quantity: 1000, receivedAt: AT },
];

function invoice(lines: Invoice["lines"], documentNo = "BRC-2026-4892"): Invoice {
  return {
    id: "INV-1",
    partnerId: "p-burcelik",
    documentNo,
    issuedAt: AT,
    currency: "TRY",
    lines,
  };
}

describe("tolerans mantığı — iki eşik birlikte", () => {
  it("yüzde büyük ama para küçükse bloklanmaz", () => {
    // 10 TL'lik kalemde %50 sapma = 5 TL. İnsana götürmeye değmez.
    const r = exceedsPriceTolerance(10, 15, 1, DEFAULT_TOLERANCE);
    expect(r.percent).toBe(50);
    expect(r.exceeded).toBe(false);
  });

  it("para büyük ama yüzde küçükse de bloklanmaz", () => {
    // 10.000.000 TL'lik kalemde %0,5 sapma. Yüzde eşiği aşılmıyor.
    const r = exceedsPriceTolerance(10_000_000, 10_050_000, 1, DEFAULT_TOLERANCE);
    expect(r.percent).toBe(0.5);
    expect(r.exceeded).toBe(false);
  });

  it("hem yüzde hem para eşiği aşılırsa bloklanır", () => {
    const r = exceedsPriceTolerance(1750, 1870, 200, DEFAULT_TOLERANCE);
    expect(r.percent).toBeGreaterThan(2);
    expect(r.absolute).toBe(24_000);
    expect(r.exceeded).toBe(true);
  });
});

describe("üç yönlü eşleştirme", () => {
  it("temiz fatura eşleşir ve güven 100 olur", () => {
    const r = matchInvoice({
      invoice: invoice([
        { lineNo: 1, poId: "PO-2026-118", poLineNo: 1, itemId: "DINGIL-22310", quantity: 200, unitPrice: 1750, currency: "TRY" },
      ]),
      poLines: PO,
      receipts: GR,
    });
    expect(r.status).toBe("matched");
    expect(r.findings).toHaveLength(0);
    expect(r.confidence).toBe(100);
    expect(r.totalVariance).toBe(0);
  });

  it("BURÇELİK SENARYOSU: fiyat sapması yakalanır ve tutarı hesaplanır", () => {
    const r = matchInvoice({
      invoice: invoice([
        // Sipariş 1750, fatura 1870 → %6,86 sapma
        { lineNo: 1, poId: "PO-2026-118", poLineNo: 1, itemId: "DINGIL-22310", quantity: 200, unitPrice: 1870, currency: "TRY" },
      ]),
      poLines: PO,
      receipts: GR,
    });
    expect(r.status).toBe("blocked");
    const finding = r.findings.find((f) => f.reason === "price_variance");
    expect(finding).toBeDefined();
    expect(finding!.detail["variancePercent"]).toBeCloseTo(6.86, 1);
    expect(finding!.impact).toBe(24_000);
    expect(r.totalVariance).toBe(24_000);
    expect(finding!.message).toContain("yüksek");
  });

  it("teslim alınmamış mal faturalanamaz", () => {
    const r = matchInvoice({
      invoice: invoice([
        { lineNo: 1, poId: "PO-2026-118", poLineNo: 1, itemId: "DINGIL-22310", quantity: 200, unitPrice: 1750, currency: "TRY" },
      ]),
      poLines: PO,
      receipts: [],
    });
    expect(r.findings[0]?.reason).toBe("no_goods_receipt");
  });

  it("teslim alınandan fazla faturalama yakalanır", () => {
    const r = matchInvoice({
      invoice: invoice([
        { lineNo: 1, poId: "PO-2026-118", poLineNo: 1, itemId: "DINGIL-22310", quantity: 250, unitPrice: 1750, currency: "TRY" },
      ]),
      poLines: PO,
      receipts: GR,
    });
    const f = r.findings.find((x) => x.reason === "quantity_exceeds_receipt");
    expect(f?.detail["excess"]).toBe(50);
    expect(f?.impact).toBe(87_500);
  });

  it("siparişsiz kalem onaya gidemez", () => {
    const r = matchInvoice({
      invoice: invoice([
        { lineNo: 1, poId: null, poLineNo: null, itemId: "SERBEST", quantity: 5, unitPrice: 1000, currency: "TRY" },
      ]),
      poLines: PO,
      receipts: GR,
    });
    expect(r.findings[0]?.reason).toBe("no_po_reference");
  });

  it("para birimi uyuşmazlığı yakalanır", () => {
    const r = matchInvoice({
      invoice: {
        ...invoice([
          { lineNo: 1, poId: "PO-2026-118", poLineNo: 1, itemId: "DINGIL-22310", quantity: 200, unitPrice: 1750, currency: "EUR" },
        ]),
        currency: "EUR",
      },
      poLines: PO,
      receipts: GR,
    });
    expect(r.findings[0]?.reason).toBe("currency_mismatch");
  });

  it("mükerrer fatura numarası yakalanır", () => {
    const r = matchInvoice({
      invoice: invoice([
        { lineNo: 1, poId: "PO-2026-118", poLineNo: 1, itemId: "DINGIL-22310", quantity: 200, unitPrice: 1750, currency: "TRY" },
      ]),
      poLines: PO,
      receipts: GR,
      previousDocumentNos: ["BRC-2026-4892"],
    });
    expect(r.findings.some((f) => f.reason === "duplicate_invoice")).toBe(true);
    expect(r.findings.find((f) => f.reason === "duplicate_invoice")?.message).toContain("Mükerrer ödeme riski");
  });

  it("bulgular parasal etkiye göre sıralanır — dikkat büyük paraya gider", () => {
    const r = matchInvoice({
      invoice: invoice([
        { lineNo: 1, poId: "PO-2026-118", poLineNo: 2, itemId: "CIVATA-M12", quantity: 1200, unitPrice: 8, currency: "TRY" },
        { lineNo: 2, poId: "PO-2026-118", poLineNo: 1, itemId: "DINGIL-22310", quantity: 200, unitPrice: 1870, currency: "TRY" },
      ]),
      poLines: PO,
      receipts: GR,
    });
    expect(r.findings.length).toBeGreaterThanOrEqual(2);
    expect(r.findings[0]!.impact).toBeGreaterThanOrEqual(r.findings[1]!.impact);
    expect(r.findings[0]!.itemId).toBe("DINGIL-22310");
  });
});

// ─────────────────────── onay akışı ───────────────────────

const hazirlayan = createPrincipal({ userId: "u-hazirlayan", tenantId: "t1", roles: ["satin_alma"] });
const cfo = createPrincipal({
  userId: "u-cfo",
  tenantId: "t1",
  roles: ["cfo"],
  approvalLimit: { amount: 500_000, currency: "TRY" },
});
const cfoLimitsiz = createPrincipal({ userId: "u-cfo2", tenantId: "t1", roles: ["cfo"] });
const patron = createPrincipal({
  userId: "u-patron",
  tenantId: "t1",
  roles: ["patron"],
  approvalLimit: { amount: 10_000_000, currency: "TRY" },
});

function ws(over: Partial<Parameters<typeof createWorkspace>[0]> = {}) {
  return createWorkspace({
    id: "AW-1",
    kind: "invoice_acceptance",
    title: "Burçelik BRC-2026-4892 fatura kabulü",
    preparedBy: hazirlayan.userId,
    amount: { amount: 374_000, currency: "TRY" },
    requiredPermission: "approval:finance.submit",
    payload: { invoiceId: "INV-1" },
    at: AT,
    ...over,
  });
}

describe("onay akışı — yapısal kontroller", () => {
  it("HAZIRLAYAN ONAYLAYAMAZ", () => {
    const w = submitForReview(ws(), { principal: hazirlayan, channel: "chat", at: AT });
    expect(() => approve(w, { principal: hazirlayan, channel: "chat", at: AT })).toThrow(
      /hazırlayan kişi onaylayamaz/,
    );
  });

  it("yetkisiz kişi onaylayamaz", () => {
    const w = submitForReview(ws(), { principal: hazirlayan, channel: "chat", at: AT });
    const depo = createPrincipal({ userId: "u-depo", tenantId: "t1", roles: ["depo_sorumlusu"] });
    expect(() => approve(w, { principal: depo, channel: "chat", at: AT })).toThrow(
      /izni gerekir/,
    );
  });

  it("ONAY LİMİTİ AŞILIRSA reddedilir ve eskale istenir", () => {
    const w = submitForReview(ws({ amount: { amount: 1_200_000, currency: "TRY" } }), {
      principal: hazirlayan,
      channel: "chat",
      at: AT,
    });
    expect(() => approve(w, { principal: cfo, channel: "chat", at: AT })).toThrow(
      /Üst yetkiye eskale/,
    );
    // Patron limiti yeterli
    expect(() => approve(w, { principal: patron, channel: "chat", at: AT })).not.toThrow();
  });

  it("limiti tanımsız kullanıcı tutarlı belge onaylayamaz", () => {
    const w = submitForReview(ws(), { principal: hazirlayan, channel: "chat", at: AT });
    expect(() => approve(w, { principal: cfoLimitsiz, channel: "chat", at: AT })).toThrow(
      /onay limitiniz yok/,
    );
  });

  it("limit para birimi farklıysa kur çevrimi olmadan onaylanmaz", () => {
    const w = submitForReview(ws({ amount: { amount: 5_000, currency: "EUR" } }), {
      principal: hazirlayan,
      channel: "chat",
      at: AT,
    });
    expect(() => approve(w, { principal: cfo, channel: "chat", at: AT })).toThrow(
      /Kur çevrimi olmadan/,
    );
  });

  it("RİSKLER TEYİT EDİLMEDEN onaylanamaz", () => {
    const w = submitForReview(ws({ risks: ["%6,8 fiyat sapması", "2 kalem PO ile eşleşmedi"] }), {
      principal: hazirlayan,
      channel: "chat",
      at: AT,
    });
    expect(() => approve(w, { principal: cfo, channel: "chat", at: AT })).toThrow(
      /riskler açıkça teyit edilmelidir/,
    );
    expect(() =>
      approve(w, { principal: cfo, channel: "chat", at: AT, risksAcknowledged: true }),
    ).not.toThrow();
  });
});

describe("onay akışı — L4 sınırı", () => {
  function approved() {
    const w = submitForReview(ws({ amount: null }), { principal: hazirlayan, channel: "chat", at: AT });
    return approve(w, { principal: cfo, channel: "chat", at: AT });
  }

  it("KULLANICI 'gönderildi' işaretleyemez — sohbetten de arayüzden de", () => {
    for (const channel of ["chat", "ui", "mobile", "api"] as const) {
      expect(() =>
        recordExternalSubmission(approved(), {
          channel,
          at: AT,
          integrator: "uyumsoft",
          reference: "X",
        }),
      ).toThrow(/yalnızca entegrasyon işi/);
    }
  });

  it("entegrasyon işi kaydedebilir", () => {
    const w = recordExternalSubmission(approved(), {
      channel: "job",
      at: AT,
      integrator: "uyumsoft",
      reference: "UYM-99181",
    });
    expect(w.state).toBe("submitted_externally");
    expect(pendingOn(w)).toContain("dış sistem sonucu");
  });

  it("onaylanan belge kullanıcıya 'KAELON göndermez' der", () => {
    expect(pendingOn(approved())).toContain("KAELON göndermez");
  });
});

describe("onay akışı — durum makinesi", () => {
  it("geçersiz geçiş reddedilir ve izin verilenler söylenir", () => {
    expect(() => approve(ws(), { principal: cfo, channel: "chat", at: AT })).toThrow(
      /"preparing" durumundan "approved" durumuna geçilemez/,
    );
  });

  it("düzeltme gerekçesiz istenemez", () => {
    const w = submitForReview(ws(), { principal: hazirlayan, channel: "chat", at: AT });
    expect(() =>
      returnForCorrection(w, { principal: cfo, channel: "chat", at: AT, reason: " " }),
    ).toThrow(/gerekçesiz/);
  });

  it("tam yaşam döngüsü ve geçmiş kaydı", () => {
    let w = ws({ amount: null });
    w = submitForReview(w, { principal: hazirlayan, channel: "chat", at: AT });
    w = returnForCorrection(w, {
      principal: cfo,
      channel: "chat",
      at: AT,
      reason: "2 kalemde PO eşleşmesi eksik",
    });
    w = submitForReview(w, { principal: hazirlayan, channel: "chat", at: AT });
    w = approve(w, { principal: cfo, channel: "chat", at: AT, note: "düzeltmeler tamam" });
    w = recordExternalSubmission(w, { channel: "job", at: AT, integrator: "uyumsoft", reference: "R1" });
    w = recordExternalResult(w, { channel: "job", at: AT, accepted: true, detail: "GİB kabul" });
    w = archive(w, { principal: cfo, channel: "chat", at: AT });

    expect(w.state).toBe("archived");
    expect(w.approvedBy).toBe("u-cfo");
    // Geçmiş eksiksiz: oluşturma + 7 geçiş
    expect(w.history).toHaveLength(8);
    expect(w.history.map((h) => h.to)).toEqual([
      "preparing",
      "ready_for_review",
      "returned_for_correction",
      "ready_for_review",
      "approved",
      "submitted_externally",
      "accepted",
      "archived",
    ]);
    // Düzeltme gerekçesi geçmişte kalıcı
    expect(w.history[2]?.note).toContain("PO eşleşmesi eksik");
    // Kim onayladı, hangi kanaldan — denetlenebilir
    expect(w.history[4]).toMatchObject({ to: "approved", by: "u-cfo", channel: "chat" });
    expect(w.history[5]?.by).toBe("integrator:uyumsoft");
  });

  it("arşivden çıkış yoktur", () => {
    let w = ws({ amount: null });
    w = submitForReview(w, { principal: hazirlayan, channel: "chat", at: AT });
    w = approve(w, { principal: cfo, channel: "chat", at: AT });
    w = archive(w, { principal: cfo, channel: "chat", at: AT });
    expect(() => submitForReview(w, { principal: hazirlayan, channel: "chat", at: AT })).toThrow(
      /son durum/,
    );
  });
});
