/**
 * Belge ve onay tool'ları.
 *
 * Zincir: fatura → üç yönlü eşleştirme → (bloklandıysa) onay kaydı →
 * inceleme → onay/düzeltme. Resmî gönderim bu zincirde YOKTUR ve olamaz.
 */

import { z } from "zod";
import { defineTool } from "../../kernel/tool.js";
import type { SourceRef, ToolOk } from "../../kernel/types.js";
import { BusinessRuleError } from "../../kernel/errors.js";
import { matchInvoice, type MatchResult } from "./three-way-match.js";
import type { ApprovalRepository, DocumentsRepository } from "./repository.js";
import {
  approve,
  createWorkspace,
  pendingOn,
  returnForCorrection,
  submitForReview,
  type ApprovalWorkspace,
} from "../approval/workspace.js";

function src(now: Date, count: number, system: string): SourceRef[] {
  return [{ system, kind: "module", recordCount: count, syncedAt: now.toISOString() }];
}

/** Onay kaydını modele anlatılabilir biçimde özetler. */
function summarize(ws: ApprovalWorkspace) {
  return {
    id: ws.id,
    kind: ws.kind,
    title: ws.title,
    state: ws.state,
    preparedBy: ws.preparedBy,
    approvedBy: ws.approvedBy,
    amount: ws.amount,
    risks: ws.risks,
    pendingOn: pendingOn(ws),
    historyCount: ws.history.length,
  };
}

export function documentTools(docs: DocumentsRepository, approvals: ApprovalRepository) {
  const matchInvoiceTool = defineTool({
    name: "match_invoice",
    module: "documents",
    authority: 1,
    deferLoading: false,
    description: {
      tr: "Bir gelen faturayı satın alma siparişi ve mal kabul kayıtlarıyla üç yönlü eşleştirir. Fiyat sapması, teslim alınandan fazla faturalama, mal kabulsüz kalem, siparişsiz kalem, para birimi uyuşmazlığı ve mükerrer fatura numarasını yakalar. 'Bu fatura ödenebilir mi', 'faturada sorun var mı', 'neden bloklandı' sorularında kullan.",
      en: "Runs a three-way match (PO ↔ goods receipt ↔ invoice) and returns blocking findings ordered by monetary impact.",
    },
    input: z.strictObject({
      invoiceId: z.string().min(1).describe("Fatura kimliği"),
    }),
    requires: ["documents:invoice.read"],
    async execute(input, ctx): Promise<ToolOk<MatchResult | null>> {
      const invoice = await docs.getInvoice(ctx.tenant.tenantId, input.invoiceId);
      if (!invoice) {
        return {
          ok: true,
          data: null,
          sources: src(ctx.now(), 0, "Document Intelligence"),
          risks: [
            {
              severity: "info",
              message: `${input.invoiceId} numaralı fatura yok. Uydurma sonuç verme.`,
            },
          ],
        };
      }

      const poIds = [...new Set(invoice.lines.map((l) => l.poId).filter((x): x is string => !!x))];
      const [poLines, receipts, previousDocumentNos] = await Promise.all([
        docs.poLinesFor(ctx.tenant.tenantId, poIds),
        docs.receiptsFor(ctx.tenant.tenantId, poIds),
        docs.previousDocumentNos(ctx.tenant.tenantId, invoice.partnerId, invoice.id),
      ]);

      const result = matchInvoice({ invoice, poLines, receipts, previousDocumentNos });
      await docs.saveMatchResult(ctx.tenant.tenantId, result);

      return {
        ok: true,
        data: result,
        sources: [
          ...src(ctx.now(), invoice.lines.length, "e-Fatura"),
          ...src(ctx.now(), poLines.length, "Satın alma siparişi"),
          ...src(ctx.now(), receipts.length, "Mal kabul"),
        ],
        risks: result.findings.map((f) => ({
          severity: f.reason === "duplicate_invoice" ? ("critical" as const) : ("warning" as const),
          message: f.message,
          ref: `line:${f.lineNo}`,
        })),
        confidence: result.confidence,
      };
    },
  });

  const listBlockedInvoices = defineTool({
    name: "list_blocked_invoices",
    module: "documents",
    authority: 0,
    description: {
      tr: "Eşleştirmede bloklanmış faturaları listeler; her biri için sapma tutarı ve ana neden döner. 'Hangi faturalar bekliyor', 'ödemede takılan var mı' sorularında kullan.",
      en: "Lists invoices blocked by three-way matching with variance amounts and primary reasons.",
    },
    input: z.strictObject({
      status: z.enum(["blocked", "matched"]).describe("Filtrelenecek eşleştirme durumu"),
    }),
    requires: ["documents:invoice.read"],
    async execute(input, ctx) {
      const rows = await docs.listByMatchStatus(ctx.tenant.tenantId, input.status);
      const total = rows.reduce((s, r) => s + Math.abs(r.totalVariance), 0);
      return {
        ok: true as const,
        data: rows,
        sources: src(ctx.now(), rows.length, "Document Intelligence"),
        risks:
          input.status === "blocked" && rows.length > 0
            ? [
                {
                  severity: "warning" as const,
                  message: `${rows.length} fatura bloklanmış; toplam sapma ${total.toLocaleString("tr-TR")}.`,
                },
              ]
            : [],
        confidence: 100,
      };
    },
  });

  // ─────────────────────── onay akışı ───────────────────────

  const openApproval = defineTool({
    name: "open_approval_for_invoice",
    module: "approval",
    authority: 1,
    description: {
      tr: "Bloklanmış bir fatura için onay kaydı açar ve eşleştirme bulgularını risk olarak ekler. Onay kaydı açılınca belge, hazırlayan DIŞINDA bir yetkilinin incelemesine gider.",
      en: "Opens an approval workspace for a blocked invoice, carrying match findings as risks.",
    },
    input: z.strictObject({
      invoiceId: z.string().min(1),
      title: z.string().min(5).describe("İnsanın listede göreceği başlık"),
    }),
    requires: ["approval:procurement.submit"],
    async execute(input, ctx): Promise<ToolOk<ReturnType<typeof summarize>>> {
      const invoice = await docs.getInvoice(ctx.tenant.tenantId, input.invoiceId);
      if (!invoice) throw new BusinessRuleError(`Fatura bulunamadı: ${input.invoiceId}`, "invoice_not_found");

      const poIds = [...new Set(invoice.lines.map((l) => l.poId).filter((x): x is string => !!x))];
      const [poLines, receipts, previousDocumentNos] = await Promise.all([
        docs.poLinesFor(ctx.tenant.tenantId, poIds),
        docs.receiptsFor(ctx.tenant.tenantId, poIds),
        docs.previousDocumentNos(ctx.tenant.tenantId, invoice.partnerId, invoice.id),
      ]);
      const match = matchInvoice({ invoice, poLines, receipts, previousDocumentNos });

      const total = invoice.lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0);
      const ws = createWorkspace({
        id: `AW-${invoice.id}`,
        kind: "invoice_acceptance",
        title: input.title,
        preparedBy: ctx.principal.userId,
        amount: { amount: Math.round(total * 100) / 100, currency: invoice.currency },
        requiredPermission: "approval:finance.submit",
        payload: { invoiceId: invoice.id, documentNo: invoice.documentNo, match },
        risks: match.findings.map((f) => f.message),
        at: ctx.now().toISOString(),
      });
      await approvals.create(ctx.tenant.tenantId, ws);

      const submitted = await approvals.mutate(ctx.tenant.tenantId, ws.id, (w) =>
        submitForReview(w, { principal: ctx.principal, channel: ctx.channel, at: ctx.now().toISOString() }),
      );

      return {
        ok: true,
        data: summarize(submitted),
        sources: src(ctx.now(), 1, "Approval Workspace"),
        risks: match.findings.map((f) => ({ severity: "warning" as const, message: f.message })),
        confidence: match.confidence,
      };
    },
  });

  const getApproval = defineTool({
    name: "get_approval",
    module: "approval",
    authority: 0,
    deferLoading: false,
    description: {
      tr: "Bir onay kaydının durumunu, risklerini ve şu an kimden ne beklendiğini döndürür. 'Bu onay nerede', 'kim bekliyor' sorularında kullan.",
      en: "Returns an approval workspace: state, risks and what it is currently waiting on.",
    },
    input: z.strictObject({ approvalId: z.string().min(1) }),
    requires: ["approval:read"],
    async execute(input, ctx) {
      const ws = await approvals.get(ctx.tenant.tenantId, input.approvalId);
      return {
        ok: true as const,
        data: ws ? summarize(ws) : null,
        sources: src(ctx.now(), ws ? 1 : 0, "Approval Workspace"),
        risks: ws?.risks.map((r) => ({ severity: "warning" as const, message: r })) ?? [],
        confidence: 100,
      };
    },
  });

  const listPendingApprovals = defineTool({
    name: "list_pending_approvals",
    module: "approval",
    authority: 0,
    description: {
      tr: "İnceleme bekleyen onay kayıtlarını listeler. 'Onayımda ne var', 'bekleyen işler' sorularında kullan.",
      en: "Lists approval workspaces awaiting review.",
    },
    input: z.strictObject({
      state: z
        .enum([
          "preparing",
          "ready_for_review",
          "returned_for_correction",
          "approved",
          "submitted_externally",
          "accepted",
          "rejected",
          "archived",
        ])
        .nullable()
        .describe("Duruma göre filtre; tümü için null."),
    }),
    requires: ["approval:read"],
    async execute(input, ctx) {
      const rows = await approvals.listByState(ctx.tenant.tenantId, input.state);
      return {
        ok: true as const,
        data: rows.map(summarize),
        sources: src(ctx.now(), rows.length, "Approval Workspace"),
        confidence: 100,
      };
    },
  });

  const approveDocument = defineTool({
    name: "approve_document",
    module: "approval",
    authority: 2,
    description: {
      tr: "Bir onay kaydını onaylar. Taslağı hazırlayan onaylayamaz; onay limiti aşılırsa üst yetkiye eskale edilir; risk işaretli belgede riskler açıkça teyit edilmelidir. ONAY GÖNDERİM DEĞİLDİR — resmî gönderim yetkili insan ve entegratör tarafından yapılır.",
      en: "Approves a workspace. Preparer cannot approve; approval limit and risk acknowledgement enforced. Approval is not submission.",
    },
    input: z.strictObject({
      approvalId: z.string().min(1),
      risksAcknowledged: z
        .boolean()
        .describe("Kullanıcı riskleri gördüğünü teyit etti mi? Riskli belgede true olmalı."),
      note: z.string().min(3).nullable().describe("Onay notu; yoksa null."),
    }),
    requires: ["approval:read"],
    async execute(input, ctx) {
      const ws = await approvals.mutate(ctx.tenant.tenantId, input.approvalId, (w) =>
        approve(w, {
          principal: ctx.principal,
          channel: ctx.channel,
          at: ctx.now().toISOString(),
          risksAcknowledged: input.risksAcknowledged,
          ...(input.note ? { note: input.note } : {}),
        }),
      );
      return {
        ok: true as const,
        data: summarize(ws),
        sources: src(ctx.now(), 1, "Approval Workspace"),
        risks: [
          {
            severity: "info" as const,
            message:
              "Onaylandı. Resmî gönderim KAELON tarafından YAPILMAZ; yetkili insan ve entegratör üzerinden yürür.",
          },
        ],
        confidence: 100,
      };
    },
  });

  const returnDocument = defineTool({
    name: "return_for_correction",
    module: "approval",
    authority: 2,
    description: {
      tr: "Onay kaydını gerekçeyle düzeltmeye geri gönderir. Gerekçe zorunludur ve geçmişte kalıcı olarak saklanır.",
      en: "Returns an approval workspace for correction with a mandatory, permanently recorded reason.",
    },
    input: z.strictObject({
      approvalId: z.string().min(1),
      reason: z.string().min(10).describe("Neyin düzeltilmesi gerektiği"),
    }),
    requires: ["approval:read"],
    async execute(input, ctx) {
      const ws = await approvals.mutate(ctx.tenant.tenantId, input.approvalId, (w) =>
        returnForCorrection(w, {
          principal: ctx.principal,
          channel: ctx.channel,
          at: ctx.now().toISOString(),
          reason: input.reason,
        }),
      );
      return {
        ok: true as const,
        data: summarize(ws),
        sources: src(ctx.now(), 1, "Approval Workspace"),
        confidence: 100,
      };
    },
  });

  return [
    matchInvoiceTool,
    listBlockedInvoices,
    openApproval,
    getApproval,
    listPendingApprovals,
    approveDocument,
    returnDocument,
  ] as const;
}
