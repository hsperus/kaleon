/**
 * Satın alma talebi ve ödeme deposu.
 *
 * ONAY VE ÖDEME AYNI DİSİPLİNİ PAYLAŞIR: her ikisi de bir kontrolün
 * uygulandığı andır ve her ikisinde de kontrolü atlamak, kontrolü hiç
 * koymamaktan daha kötüdür — çünkü sistem kontrol varmış gibi görünür.
 */

import { Prisma } from "./generated/tenant/index.js";
import type { TenantDb } from "./client.js";
import { nextDocumentNo } from "./sales-repository.js";
import { assertPeriodOpen } from "./period-repository.js";
import { JournalRepository } from "./journal-repository.js";
import { paymentLines } from "../modules/accounting/posting-rules.js";
import {
  approverFor,
  assertApprovable,
  assertOrderable,
  estimateTotal,
  RequisitionError,
  type RequisitionStatus,
} from "../modules/procurement/requisition.js";
import {
  assertFullyAllocated,
  assertPayable,
  openAmount,
  PaymentError,
  type InvoiceBalance,
  type PaymentMethod,
} from "../modules/finance/payment.js";

export interface RequisitionView {
  readonly documentNo: string;
  readonly status: RequisitionStatus;
  readonly requestedBy: string;
  readonly estimatedTotal: number | null;
  readonly requiredApprover: string;
  readonly unpricedLines: readonly number[];
  readonly lines: readonly {
    lineNo: number;
    itemCode: string;
    quantity: number;
    uom: string;
    estimatedPrice: number | null;
    neededBy: string;
  }[];
}

export class ProcurementRepository {
  readonly #db: TenantDb;

  constructor(db: TenantDb) {
    this.#db = db;
  }

  async createRequisition(input: {
    requestedBy: string;
    department?: string | null;
    justification?: string | null;
    at: Date;
    lines: readonly {
      itemCode: string;
      quantity: number;
      uom: string;
      estimatedPrice: number | null;
      neededBy: Date;
    }[];
  }): Promise<RequisitionView> {
    if (input.lines.length === 0) {
      throw new RequisitionError("Talep en az bir kalem içermelidir.");
    }

    return this.#db.$transaction(async (tx) => {
      const documentNo = await nextDocumentNo(tx, "purchase_requisition", input.at.getUTCFullYear());
      const numbered = input.lines.map((l, i) => ({ ...l, lineNo: i + 1 }));
      const est = estimateTotal(
        numbered.map((l) => ({
          lineNo: l.lineNo,
          itemCode: l.itemCode,
          quantity: l.quantity,
          uom: l.uom,
          estimatedPrice: l.estimatedPrice,
          neededBy: l.neededBy,
        })),
      );

      const row = await tx.purchaseRequisition.create({
        data: {
          documentNo,
          status: "submitted",
          requestedBy: input.requestedBy,
          department: input.department ?? null,
          justification: input.justification ?? null,
          // Fiyatsız kalem varsa toplam EKSİKTİR; null yazmak yerine
          // hesaplananı yazıp eksikliği ayrıca söylüyoruz — onay anında
          // `assertApprovable` zaten reddedecek.
          estimatedTotal: new Prisma.Decimal(est.total),
          lines: {
            create: numbered.map((l) => ({
              lineNo: l.lineNo,
              itemId: l.itemCode,
              quantity: new Prisma.Decimal(l.quantity),
              uom: l.uom,
              estimatedPrice:
                l.estimatedPrice === null ? null : new Prisma.Decimal(l.estimatedPrice),
              neededBy: l.neededBy,
            })),
          },
        },
        include: { lines: { orderBy: { lineNo: "asc" } } },
      });

      return toRequisitionView(row, est);
    });
  }

  async requisitionByNo(documentNo: string): Promise<RequisitionView | null> {
    const row = await this.#db.purchaseRequisition.findUnique({
      where: { documentNo },
      include: { lines: { orderBy: { lineNo: "asc" } } },
    });
    if (!row) return null;
    return toRequisitionView(row, estimateFromRow(row));
  }

  /**
   * Talebi onaylar.
   *
   * KENDİ TALEBİNİ ONAYLAMA KONTROLÜ HEM BURADA HEM VERİTABANINDA. Burada
   * olması kullanıcıya anlamlı bir mesaj verir; veritabanında olması,
   * ileride yazılacak başka bir kod yolunun onu atlamasını engeller.
   */
  async approveRequisition(input: {
    documentNo: string;
    approverId: string;
    approverRoles: readonly string[];
  }): Promise<RequisitionView> {
    return this.#db.$transaction(async (tx) => {
      const row = await tx.purchaseRequisition.findUnique({
        where: { documentNo: input.documentNo },
        include: { lines: { orderBy: { lineNo: "asc" } } },
      });
      if (!row) throw new RequisitionError(`Talep bulunamadı: ${input.documentNo}`);

      const est = estimateFromRow(row);
      assertApprovable({
        status: row.status as RequisitionStatus,
        requestedBy: row.requestedBy,
        approverId: input.approverId,
        approverRoles: input.approverRoles,
        totalAmount: est.total,
        unpricedLines: est.unpricedLines,
      });

      const updated = await tx.purchaseRequisition.update({
        where: { id: row.id },
        data: { status: "approved", approvedBy: input.approverId, approvedAt: new Date() },
        include: { lines: { orderBy: { lineNo: "asc" } } },
      });
      return toRequisitionView(updated, est);
    });
  }

  async rejectRequisition(input: {
    documentNo: string;
    approverId: string;
    reason: string;
  }): Promise<void> {
    if (input.reason.trim().length < 5) {
      throw new RequisitionError("Ret sebebi yazılmalıdır; sebepsiz ret talebi tekrarlatır.");
    }
    const row = await this.#db.purchaseRequisition.findUnique({
      where: { documentNo: input.documentNo },
    });
    if (!row) throw new RequisitionError(`Talep bulunamadı: ${input.documentNo}`);
    if (row.status !== "submitted") {
      throw new RequisitionError(`Talep ${row.status} durumunda; reddedilemez.`);
    }
    await this.#db.purchaseRequisition.update({
      where: { id: row.id },
      data: {
        status: "rejected",
        rejectedBy: input.approverId,
        rejectionReason: input.reason,
      },
    });
  }

  /** Onaylı talebi siparişe dönüştürür. */
  async convertToOrder(input: {
    documentNo: string;
    partnerId: string;
    orderedAt: Date;
    currency?: string;
  }): Promise<{ purchaseOrderId: string; lines: number }> {
    return this.#db.$transaction(async (tx) => {
      const req = await tx.purchaseRequisition.findUnique({
        where: { documentNo: input.documentNo },
        include: { lines: { orderBy: { lineNo: "asc" } } },
      });
      if (!req) throw new RequisitionError(`Talep bulunamadı: ${input.documentNo}`);
      assertOrderable(req.status as RequisitionStatus);

      const poNo = await nextDocumentNo(tx, "purchase_order", input.orderedAt.getUTCFullYear());
      const currency = input.currency ?? req.currency;

      await tx.purchaseOrder.create({
        data: {
          id: poNo,
          partnerId: input.partnerId,
          currency,
          status: "open",
          orderedAt: input.orderedAt,
          lines: {
            create: req.lines.map((l) => ({
              lineNo: l.lineNo,
              itemId: l.itemId,
              quantity: l.quantity,
              // TAHMİNİ FİYAT SİPARİŞ FİYATI DEĞİLDİR ama bilinen tek
              // değerdir; bilinmiyorsa 0 yazılır ve sipariş fiyatsız
              // olarak ayrışır — uydurulmaz.
              unitPrice: l.estimatedPrice ?? new Prisma.Decimal(0),
              currency,
            })),
          },
        },
      });

      await tx.purchaseRequisition.update({
        where: { id: req.id },
        data: { status: "ordered", purchaseOrderId: poNo },
      });

      return { purchaseOrderId: poNo, lines: req.lines.length };
    });
  }

  /** Bir gelen faturanın ödeme durumu. */
  async invoiceBalance(documentNo: string): Promise<InvoiceBalance | null> {
    const inv = await this.#db.invoice.findFirst({
      where: { documentNo },
      include: { lines: true },
    });
    if (!inv) return null;

    const total = inv.lines.reduce(
      (s, l) => s + Number(l.quantity) * Number(l.unitPrice),
      0,
    );
    const paid = await this.#db.paymentAllocation.aggregate({
      where: { invoiceNo: documentNo },
      _sum: { amount: true },
    });

    return {
      documentNo,
      totalAmount: Math.round(total * 100) / 100,
      paidAmount: Number(paid._sum.amount ?? 0),
      currency: inv.currency,
      matchStatus: inv.matchStatus,
    };
  }

  /**
   * Ödeme kaydeder ve faturalara dağıtır.
   *
   * DAĞITIM ÖDEMEYLE AYNI İŞLEMDE. Ayrı olsaydı, aradaki bir çökme
   * "bağlanmamış ödeme" bırakırdı — tam da engellemeye çalıştığımız şey.
   */
  async postPayment(input: {
    direction: "outgoing" | "incoming";
    partnerId: string;
    amount: number;
    currency?: string;
    method: PaymentMethod;
    paidAt: Date;
    userId: string;
    bankAccountId?: string | null;
    reference?: string | null;
    allocations: readonly { invoiceNo: string; amount: number }[];
  }): Promise<{ documentNo: string; allocated: number; closedInvoices: readonly string[] }> {
    const currency = input.currency ?? "TRY";
    assertFullyAllocated(input.amount, input.allocations);

    return this.#db.$transaction(async (tx) => {
      await assertPeriodOpen(tx, input.paidAt, "Ödeme");

      const closed: string[] = [];
      for (const a of input.allocations) {
        const bal = await this.invoiceBalance(a.invoiceNo);
        if (!bal) {
          throw new PaymentError(
            `${a.invoiceNo} numaralı fatura sistemde yok; olmayan bir faturaya ödeme ` +
              `bağlanamaz.`,
          );
        }
        assertPayable(bal, a.amount, currency);
        if (Math.abs(openAmount(bal) - a.amount) < 0.005) closed.push(a.invoiceNo);
      }

      const documentNo = await nextDocumentNo(tx, "payment", input.paidAt.getUTCFullYear());

      const payment = await tx.payment.create({
        data: {
          documentNo,
          direction: input.direction,
          partnerId: input.partnerId,
          amount: new Prisma.Decimal(input.amount),
          currency,
          method: input.method,
          paidAt: input.paidAt,
          bankAccountId: input.bankAccountId ?? null,
          reference: input.reference ?? null,
          createdBy: input.userId,
          allocations: {
            create: input.allocations.map((a) => ({
              invoiceNo: a.invoiceNo,
              amount: new Prisma.Decimal(a.amount),
            })),
          },
        },
      });

      // ÖDEME MUHASEBELEŞİR: 320 Satıcılar / 102 Bankalar.
      // Muhasebeleşmeseydi cari bakiye ödendiği hâlde açık görünür ve
      // aynı fatura ikinci kez ödenebilirdi.
      await JournalRepository.postIn(tx, {
        entryDate: input.paidAt,
        description: `${documentNo} ${input.direction === "outgoing" ? "ödeme" : "tahsilat"}`,
        sourceKind: "payment",
        sourceId: payment.id,
        lines: paymentLines({
          documentNo,
          direction: input.direction,
          partnerId: input.partnerId,
          amount: input.amount,
          method: input.method,
        }),
        userId: input.userId,
      });

      return { documentNo, allocated: input.allocations.length, closedInvoices: closed };
    });
  }

  /** Ödenmemiş faturalar — vadesi geçenler başta. */
  async openPayables(on: Date, limit = 50) {
    const invoices = await this.#db.invoice.findMany({
      where: { matchStatus: { not: "blocked" } },
      include: { lines: true },
      orderBy: { issuedAt: "asc" },
      take: 500,
    });

    const paid = await this.#db.paymentAllocation.groupBy({
      by: ["invoiceNo"],
      _sum: { amount: true },
    });
    const paidBy = new Map(paid.map((p) => [p.invoiceNo, Number(p._sum.amount ?? 0)]));

    const rows = invoices
      .map((inv) => {
        const total =
          Math.round(
            inv.lines.reduce((s, l) => s + Number(l.quantity) * Number(l.unitPrice), 0) * 100,
          ) / 100;
        const open = Math.round((total - (paidBy.get(inv.documentNo) ?? 0)) * 100) / 100;
        return {
          documentNo: inv.documentNo,
          partnerId: inv.partnerId,
          issuedAt: inv.issuedAt.toISOString().slice(0, 10),
          totalAmount: total,
          openAmount: open,
          currency: inv.currency,
          ageDays: Math.round((on.getTime() - inv.issuedAt.getTime()) / 86_400_000),
        };
      })
      .filter((r) => r.openAmount > 0.005)
      .sort((a, b) => b.ageDays - a.ageDays)
      .slice(0, limit);

    return rows;
  }
}

function estimateFromRow(row: {
  lines: { lineNo: number; itemId: string; quantity: unknown; uom: string; estimatedPrice: unknown; neededBy: Date }[];
}) {
  return estimateTotal(
    row.lines.map((l) => ({
      lineNo: l.lineNo,
      itemCode: l.itemId,
      quantity: Number(l.quantity),
      uom: l.uom,
      estimatedPrice: l.estimatedPrice === null ? null : Number(l.estimatedPrice),
      neededBy: l.neededBy,
    })),
  );
}

function toRequisitionView(
  row: {
    documentNo: string;
    status: string;
    requestedBy: string;
    estimatedTotal: unknown;
    lines: {
      lineNo: number;
      itemId: string;
      quantity: unknown;
      uom: string;
      estimatedPrice: unknown;
      neededBy: Date;
    }[];
  },
  est: { total: number; unpricedLines: readonly number[] },
): RequisitionView {
  return {
    documentNo: row.documentNo,
    status: row.status as RequisitionStatus,
    requestedBy: row.requestedBy,
    estimatedTotal: row.estimatedTotal === null ? null : Number(row.estimatedTotal),
    requiredApprover: approverFor(est.total),
    unpricedLines: est.unpricedLines,
    lines: row.lines.map((l) => ({
      lineNo: l.lineNo,
      itemCode: l.itemId,
      quantity: Number(l.quantity),
      uom: l.uom,
      estimatedPrice: l.estimatedPrice === null ? null : Number(l.estimatedPrice),
      neededBy: l.neededBy.toISOString().slice(0, 10),
    })),
  };
}
