/**
 * Belge ve onay repository'lerinin Postgres adaptörleri.
 *
 * İki nokta özellikle önemlidir:
 *
 *  1. MÜKERRER FATURA — uygulama katmanındaki kontrol yarışa açıktır. Burada
 *     `@@unique([partnerId, documentNo])` kısıtı gerçek savunmadır; adaptör
 *     kısıt ihlalini (P2002) yakalayıp anlamlı bir iş kuralı hatasına çevirir.
 *     Kullanıcı "veritabanı hatası" değil, "bu fatura zaten kayıtlı" görür.
 *
 *  2. ONAY GEÇMİŞİ APPEND-ONLY — mutasyonda geçmiş silinip yeniden yazılmaz;
 *     yalnızca yeni olaylar eklenir. Geçmişin yeniden yazılabilir olması,
 *     onay izinin değerini sıfırlar.
 */

import { Prisma } from "./generated/tenant/index.js";
import type { TenantDb } from "./client.js";
import { BusinessRuleError } from "../kernel/errors.js";
import type {
  ApprovalRepository,
  DocumentsRepository,
  InvoiceSummary,
} from "../modules/documents/repository.js";
import type {
  GoodsReceiptLine,
  Invoice,
  MatchResult,
  PurchaseOrderLine,
} from "../modules/documents/three-way-match.js";
import type {
  ApprovalEvent,
  ApprovalState,
  ApprovalWorkspace,
} from "../modules/approval/workspace.js";

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

export class PrismaDocumentsRepository implements DocumentsRepository {
  readonly #db: TenantDb;
  constructor(db: TenantDb) {
    this.#db = db;
  }

  async getInvoice(_t: string, invoiceId: string): Promise<Invoice | null> {
    const row = await this.#db.invoice.findUnique({
      where: { id: invoiceId },
      include: { lines: { orderBy: { lineNo: "asc" } } },
    });
    if (!row) return null;
    return {
      id: row.id,
      partnerId: row.partnerId,
      documentNo: row.documentNo,
      issuedAt: row.issuedAt.toISOString(),
      currency: row.currency,
      lines: row.lines.map((l) => ({
        lineNo: l.lineNo,
        poId: l.poId,
        poLineNo: l.poLineNo,
        itemId: l.itemId,
        quantity: num(l.quantity),
        unitPrice: num(l.unitPrice),
        currency: l.currency,
      })),
    };
  }

  async poLinesFor(_t: string, poIds: readonly string[]): Promise<readonly PurchaseOrderLine[]> {
    if (poIds.length === 0) return [];
    const rows = await this.#db.purchaseOrderLine.findMany({
      where: { poId: { in: [...poIds] } },
      orderBy: [{ poId: "asc" }, { lineNo: "asc" }],
    });
    return rows.map((r) => ({
      poId: r.poId,
      lineNo: r.lineNo,
      itemId: r.itemId,
      quantity: num(r.quantity),
      unitPrice: num(r.unitPrice),
      currency: r.currency,
    }));
  }

  async receiptsFor(_t: string, poIds: readonly string[]): Promise<readonly GoodsReceiptLine[]> {
    if (poIds.length === 0) return [];
    const rows = await this.#db.goodsReceipt.findMany({
      where: { poId: { in: [...poIds] } },
      orderBy: { receivedAt: "asc" },
    });
    return rows.map((r) => ({
      grId: r.id,
      poId: r.poId,
      poLineNo: r.poLineNo,
      quantity: num(r.quantity),
      receivedAt: r.receivedAt.toISOString(),
    }));
  }

  async previousDocumentNos(
    _t: string,
    partnerId: string,
    excludeInvoiceId: string,
  ): Promise<readonly string[]> {
    const rows = await this.#db.invoice.findMany({
      where: { partnerId, id: { not: excludeInvoiceId } },
      select: { documentNo: true },
    });
    return rows.map((r) => r.documentNo);
  }

  async saveMatchResult(_t: string, result: MatchResult): Promise<void> {
    await this.#db.$transaction(async (tx) => {
      await tx.invoiceFinding.deleteMany({ where: { invoiceId: result.invoiceId } });
      if (result.findings.length > 0) {
        await tx.invoiceFinding.createMany({
          data: result.findings.map((f) => ({
            invoiceId: result.invoiceId,
            lineNo: f.lineNo,
            itemId: f.itemId,
            reason: f.reason,
            message: f.message,
            impact: f.impact,
            detail: f.detail as never,
          })),
        });
      }
      await tx.invoice.update({
        where: { id: result.invoiceId },
        data: {
          matchStatus: result.status,
          totalVariance: result.totalVariance,
          matchedAt: new Date(),
        },
      });
    });
  }

  async listByMatchStatus(_t: string, status: string): Promise<readonly InvoiceSummary[]> {
    const rows = await this.#db.invoice.findMany({
      where: { matchStatus: status },
      include: { findings: { orderBy: { impact: "desc" } } },
      orderBy: { documentNo: "asc" },
    });
    return rows.map((r) => ({
      id: r.id,
      partnerId: r.partnerId,
      documentNo: r.documentNo,
      matchStatus: r.matchStatus,
      totalVariance: num(r.totalVariance),
      findingCount: r.findings.length,
      topFinding: r.findings[0]?.message ?? null,
    }));
  }

  /**
   * Fatura kaydeder. Mükerrer belge numarası veritabanı kısıtıyla yakalanır
   * ve kullanıcıya anlamlı bir iş kuralı hatası olarak döner.
   */
  async createInvoice(_t: string, invoice: Invoice): Promise<void> {
    try {
      await this.#db.invoice.create({
        data: {
          id: invoice.id,
          partnerId: invoice.partnerId,
          documentNo: invoice.documentNo,
          issuedAt: new Date(invoice.issuedAt),
          currency: invoice.currency,
          lines: {
            create: invoice.lines.map((l) => ({
              lineNo: l.lineNo,
              poId: l.poId,
              poLineNo: l.poLineNo,
              itemId: l.itemId,
              quantity: l.quantity,
              unitPrice: l.unitPrice,
              currency: l.currency,
            })),
          },
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        throw new BusinessRuleError(
          `Bu tedarikçiden "${invoice.documentNo}" numaralı fatura zaten kayıtlı. ` +
            `Mükerrer ödeme riski nedeniyle ikinci kayıt oluşturulmadı.`,
          "duplicate_invoice",
        );
      }
      throw e;
    }
  }
}

// ─────────────────────────── onay ───────────────────────────

type WsRow = {
  id: string;
  kind: string;
  title: string;
  state: string;
  preparedBy: string;
  approvedBy: string | null;
  amount: unknown;
  currency: string | null;
  requiredPermission: string;
  payload: unknown;
  risks: string[];
  version: number;
  events: {
    at: Date;
    fromState: string;
    toState: string;
    by: string;
    channel: string;
    note: string | null;
    seq: number;
  }[];
};

function toWorkspace(row: WsRow): ApprovalWorkspace {
  return {
    id: row.id,
    kind: row.kind as ApprovalWorkspace["kind"],
    title: row.title,
    state: row.state as ApprovalState,
    preparedBy: row.preparedBy,
    approvedBy: row.approvedBy,
    amount:
      row.amount !== null && row.currency
        ? { amount: num(row.amount), currency: row.currency }
        : null,
    requiredPermission: row.requiredPermission,
    payload: row.payload,
    risks: row.risks,
    history: [...row.events]
      .sort((a, b) => a.seq - b.seq)
      .map(
        (e): ApprovalEvent => ({
          at: e.at.toISOString(),
          from: e.fromState as ApprovalState,
          to: e.toState as ApprovalState,
          by: e.by,
          channel: e.channel as ApprovalEvent["channel"],
          note: e.note,
        }),
      ),
  };
}

export class PrismaApprovalRepository implements ApprovalRepository {
  readonly #db: TenantDb;
  constructor(db: TenantDb) {
    this.#db = db;
  }

  async get(_t: string, id: string): Promise<ApprovalWorkspace | null> {
    const row = await this.#db.approvalWorkspace.findUnique({
      where: { id },
      include: { events: true },
    });
    return row ? toWorkspace(row as unknown as WsRow) : null;
  }

  async create(_t: string, ws: ApprovalWorkspace): Promise<void> {
    try {
      await this.#db.approvalWorkspace.create({
        data: {
          id: ws.id,
          kind: ws.kind,
          title: ws.title,
          state: ws.state,
          preparedBy: ws.preparedBy,
          approvedBy: ws.approvedBy,
          amount: ws.amount?.amount ?? null,
          currency: ws.amount?.currency ?? null,
          requiredPermission: ws.requiredPermission,
          payload: (ws.payload ?? null) as never,
          risks: [...ws.risks],
          events: {
            create: ws.history.map((e, i) => ({
              at: new Date(e.at),
              fromState: e.from,
              toState: e.to,
              by: e.by,
              channel: e.channel,
              note: e.note,
              seq: i,
            })),
          },
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        throw new BusinessRuleError(`Onay kaydı zaten var: ${ws.id}`, "duplicate_workspace");
      }
      throw e;
    }
  }

  /**
   * Atomik dönüşüm + iyimser kilit.
   *
   * Geçmiş SİLİNMEZ: yalnızca yeni olaylar eklenir. Var olan olayların
   * güncellenebilir olması, onay izinin ispat değerini yok ederdi.
   */
  async mutate(
    _t: string,
    id: string,
    fn: (ws: ApprovalWorkspace) => ApprovalWorkspace,
  ): Promise<ApprovalWorkspace> {
    return this.#db.$transaction(async (tx) => {
      const locked = await tx.$queryRawUnsafe<{ version: number }[]>(
        `SELECT version FROM approval_workspaces WHERE id = $1 FOR UPDATE`,
        id,
      );
      if (locked.length === 0) {
        throw new BusinessRuleError(`Onay kaydı bulunamadı: ${id}`, "workspace_not_found");
      }

      const row = await tx.approvalWorkspace.findUniqueOrThrow({
        where: { id },
        include: { events: true },
      });
      const current = toWorkspace(row as unknown as WsRow);
      const next = fn(current);

      const updated = await tx.approvalWorkspace.updateMany({
        where: { id, version: locked[0]!.version },
        data: {
          state: next.state,
          approvedBy: next.approvedBy,
          risks: [...next.risks],
          version: { increment: 1 },
        },
      });
      if (updated.count !== 1) {
        throw new BusinessRuleError(
          "Onay kaydı başka bir işlem tarafından değiştirildi; tekrar deneyin.",
          "concurrent_modification",
        );
      }

      // Yalnızca YENİ olayları ekle — mevcutlara dokunma.
      const existing = current.history.length;
      const fresh = next.history.slice(existing);
      if (fresh.length > 0) {
        await tx.approvalEvent.createMany({
          data: fresh.map((e, i) => ({
            workspaceId: id,
            at: new Date(e.at),
            fromState: e.from,
            toState: e.to,
            by: e.by,
            channel: e.channel,
            note: e.note,
            seq: existing + i,
          })),
        });
      }
      return next;
    });
  }

  async listByState(
    _t: string,
    state: ApprovalState | null,
  ): Promise<readonly ApprovalWorkspace[]> {
    const rows = await this.#db.approvalWorkspace.findMany({
      where: state ? { state } : {},
      include: { events: true },
      orderBy: { id: "asc" },
    });
    return rows.map((r) => toWorkspace(r as unknown as WsRow));
  }
}
