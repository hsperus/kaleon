/**
 * Belge ve onay repository portları + bellek adaptörleri.
 *
 * Eşleştirme motoru saf kalır; veriyi getirmek ve sonucu kalıcılaştırmak
 * buranın işidir. Böylece motor veritabanı olmadan test edilir, adaptör de
 * gerçek Postgres'e karşı ayrıca doğrulanır.
 */

import { BusinessRuleError } from "../../kernel/errors.js";
import type {
  GoodsReceiptLine,
  Invoice,
  MatchResult,
  PurchaseOrderLine,
} from "./three-way-match.js";
import type { ApprovalState, ApprovalWorkspace } from "../approval/workspace.js";

export interface InvoiceSummary {
  readonly id: string;
  readonly partnerId: string;
  readonly documentNo: string;
  readonly matchStatus: string;
  readonly totalVariance: number;
  readonly findingCount: number;
  readonly topFinding: string | null;
}

export interface DocumentsRepository {
  getInvoice(tenantId: string, invoiceId: string): Promise<Invoice | null>;
  poLinesFor(tenantId: string, poIds: readonly string[]): Promise<readonly PurchaseOrderLine[]>;
  receiptsFor(tenantId: string, poIds: readonly string[]): Promise<readonly GoodsReceiptLine[]>;
  /** Aynı tedarikçinin bu fatura DIŞINDAKİ belge numaraları. */
  previousDocumentNos(
    tenantId: string,
    partnerId: string,
    excludeInvoiceId: string,
  ): Promise<readonly string[]>;
  saveMatchResult(tenantId: string, result: MatchResult): Promise<void>;
  listByMatchStatus(tenantId: string, status: string): Promise<readonly InvoiceSummary[]>;
}

export interface ApprovalRepository {
  get(tenantId: string, id: string): Promise<ApprovalWorkspace | null>;
  create(tenantId: string, ws: ApprovalWorkspace): Promise<void>;
  mutate(
    tenantId: string,
    id: string,
    fn: (ws: ApprovalWorkspace) => ApprovalWorkspace,
  ): Promise<ApprovalWorkspace>;
  listByState(tenantId: string, state: ApprovalState | null): Promise<readonly ApprovalWorkspace[]>;
}

// ─────────────────────────── bellek adaptörleri ───────────────────────────

export class InMemoryDocumentsRepository implements DocumentsRepository {
  readonly #invoices = new Map<string, Invoice>();
  readonly #po: PurchaseOrderLine[] = [];
  readonly #gr: GoodsReceiptLine[] = [];
  readonly #results = new Map<string, MatchResult>();

  constructor(seed?: {
    invoices?: readonly Invoice[];
    poLines?: readonly PurchaseOrderLine[];
    receipts?: readonly GoodsReceiptLine[];
  }) {
    for (const i of seed?.invoices ?? []) this.#invoices.set(i.id, i);
    this.#po.push(...(seed?.poLines ?? []));
    this.#gr.push(...(seed?.receipts ?? []));
  }

  async getInvoice(_t: string, id: string): Promise<Invoice | null> {
    return this.#invoices.get(id) ?? null;
  }
  async poLinesFor(_t: string, poIds: readonly string[]): Promise<readonly PurchaseOrderLine[]> {
    return this.#po.filter((p) => poIds.includes(p.poId));
  }
  async receiptsFor(_t: string, poIds: readonly string[]): Promise<readonly GoodsReceiptLine[]> {
    return this.#gr.filter((r) => poIds.includes(r.poId));
  }
  async previousDocumentNos(
    _t: string,
    partnerId: string,
    excludeInvoiceId: string,
  ): Promise<readonly string[]> {
    return [...this.#invoices.values()]
      .filter((i) => i.partnerId === partnerId && i.id !== excludeInvoiceId)
      .map((i) => i.documentNo);
  }
  async saveMatchResult(_t: string, result: MatchResult): Promise<void> {
    this.#results.set(result.invoiceId, result);
  }
  async listByMatchStatus(_t: string, status: string): Promise<readonly InvoiceSummary[]> {
    return [...this.#results.values()]
      .filter((r) => r.status === status)
      .map((r) => {
        const inv = this.#invoices.get(r.invoiceId)!;
        return {
          id: r.invoiceId,
          partnerId: inv.partnerId,
          documentNo: inv.documentNo,
          matchStatus: r.status,
          totalVariance: r.totalVariance,
          findingCount: r.findings.length,
          topFinding: r.findings[0]?.message ?? null,
        };
      });
  }
}

export class InMemoryApprovalRepository implements ApprovalRepository {
  readonly #items = new Map<string, ApprovalWorkspace>();

  async get(_t: string, id: string): Promise<ApprovalWorkspace | null> {
    return this.#items.get(id) ?? null;
  }
  async create(_t: string, ws: ApprovalWorkspace): Promise<void> {
    if (this.#items.has(ws.id)) {
      throw new BusinessRuleError(`Onay kaydı zaten var: ${ws.id}`, "duplicate_workspace");
    }
    this.#items.set(ws.id, ws);
  }
  async mutate(
    _t: string,
    id: string,
    fn: (ws: ApprovalWorkspace) => ApprovalWorkspace,
  ): Promise<ApprovalWorkspace> {
    const current = this.#items.get(id);
    if (!current) throw new BusinessRuleError(`Onay kaydı bulunamadı: ${id}`, "workspace_not_found");
    const next = fn(current);
    this.#items.set(id, next);
    return next;
  }
  async listByState(
    _t: string,
    state: ApprovalState | null,
  ): Promise<readonly ApprovalWorkspace[]> {
    return [...this.#items.values()]
      .filter((w) => (state ? w.state === state : true))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
  }
}
