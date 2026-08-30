/**
 * Belge zinciri görünümü.
 *
 * BAĞLAR TEK TEK VARDI AMA ZİNCİR GÖRÜNMÜYORDU. Fatura irsaliyeye,
 * irsaliye siparişe, sipariş teklife bağlıydı; ama kullanıcı bir
 * faturadan geriye tüm zinciri tek bakışta izleyemiyordu. SAP'nin belge
 * akışı (VA03 → Document Flow) ekranının yaptığı iş budur ve bir ERP'de
 * en sık kullanılan görünümlerden biridir: "bu fatura nereden geldi",
 * "bu sipariş ne oldu".
 *
 * ZİNCİR HER İKİ YÖNE DE YÜRÜR. Yalnızca geriye bakılsaydı "bu sipariş
 * faturalandı mı" sorusu cevapsız kalırdı; yalnızca ileriye bakılsaydı
 * "bu fatura hangi teklife dayanıyor" sorusu.
 *
 * EKSİK HALKA SESSİZ GEÇİLMEZ. Sevk edilip faturalanmamış bir sipariş,
 * zincirde boşluk olarak DEĞİL, açık bir uyarı olarak görünür.
 */

import type { TenantDb } from "./client.js";

export interface FlowNode {
  readonly kind:
    | "teklif"
    | "siparis"
    | "irsaliye"
    | "fatura"
    | "odeme"
    | "yevmiye"
    | "talep"
    | "satinalma_siparisi";
  readonly documentNo: string;
  readonly date: string;
  readonly status: string;
  readonly amount: number | null;
  readonly detail: string;
}

export interface DocumentFlow {
  readonly root: FlowNode;
  readonly upstream: readonly FlowNode[];
  readonly downstream: readonly FlowNode[];
  /** Zincirde eksik olan halkalar — sessiz geçilmez. */
  readonly gaps: readonly string[];
}

export class DocumentFlowError extends Error {
  readonly code = "document_flow_view";
  constructor(message: string) {
    super(message);
    this.name = "DocumentFlowError";
  }
}

export class DocumentFlowRepository {
  readonly #db: TenantDb;

  constructor(db: TenantDb) {
    this.#db = db;
  }

  /**
   * Bir belgeden başlayarak zincirin tamamını kurar.
   *
   * Belge türü numaradan TAHMİN EDİLMEZ, aranır: seri kodları
   * değiştirilebilir ve tahmine dayalı bir arama yanlış belgeyi getirir.
   */
  async flowOf(documentNo: string): Promise<DocumentFlow> {
    const [quotation, order, delivery, invoice, payment] = await Promise.all([
      this.#db.salesQuotation.findUnique({
        where: { documentNo },
        include: { lines: true },
      }),
      this.#db.salesOrder.findUnique({ where: { orderNo: documentNo }, include: { lines: true } }),
      this.#db.delivery.findUnique({ where: { documentNo }, include: { lines: true } }),
      this.#db.salesInvoice.findUnique({ where: { documentNo }, include: { lines: true } }),
      this.#db.payment.findUnique({ where: { documentNo }, include: { allocations: true } }),
    ]);

    if (quotation) return this.#fromQuotation(quotation.documentNo);
    if (order) return this.#fromOrder(order.orderNo);
    if (delivery) return this.#fromDelivery(delivery.documentNo);
    if (invoice) return this.#fromInvoice(invoice.documentNo);
    if (payment) return this.#fromPayment(payment.documentNo);

    throw new DocumentFlowError(
      `"${documentNo}" hiçbir belge türünde bulunamadı. Teklif, sipariş, irsaliye, ` +
        `fatura ve ödeme numaraları arasında arandı.`,
    );
  }

  /** Bir siparişin tam zinciri — en sık sorulan görünüm. */
  async #fromOrder(orderNo: string): Promise<DocumentFlow> {
    const order = await this.#db.salesOrder.findUniqueOrThrow({
      where: { orderNo },
      include: { lines: true, deliveries: { include: { lines: true } } },
    });

    const quotation = await this.#db.salesQuotation.findFirst({
      where: { salesOrderNo: orderNo },
    });

    const deliveryIds = order.deliveries.map((d) => d.id);
    const invoiceLines = deliveryIds.length
      ? await this.#db.salesInvoiceLine.findMany({
          where: { deliveryId: { in: deliveryIds } },
          include: { invoice: true },
          distinct: ["invoiceId"],
        })
      : [];

    const invoiceNos = [...new Set(invoiceLines.map((l) => l.invoice.documentNo))];
    const payments = invoiceNos.length
      ? await this.#db.paymentAllocation.findMany({
          where: { invoiceNo: { in: invoiceNos } },
          include: { payment: true },
        })
      : [];

    const orderTotal = order.lines.reduce(
      (s, l) => s + Number(l.quantity) * Number(l.unitPrice),
      0,
    );

    const root: FlowNode = {
      kind: "siparis",
      documentNo: order.orderNo,
      date: order.committedDate.toISOString().slice(0, 10),
      status: order.status,
      amount: Math.round(orderTotal * 100) / 100,
      detail: `${order.lines.length} kalem, termin ${order.committedDate
        .toISOString()
        .slice(0, 10)}`,
    };

    const upstream: FlowNode[] = quotation
      ? [
          {
            kind: "teklif",
            documentNo: quotation.documentNo,
            date: quotation.quotedAt.toISOString().slice(0, 10),
            status: quotation.status,
            amount: null,
            detail: `${quotation.validUntil.toISOString().slice(0, 10)} tarihine kadar geçerliydi`,
          },
        ]
      : [];

    const downstream: FlowNode[] = [
      ...order.deliveries.map(
        (d): FlowNode => ({
          kind: "irsaliye",
          documentNo: d.documentNo,
          date: d.shippedAt.toISOString().slice(0, 10),
          status: d.status,
          amount: null,
          detail:
            `${d.lines.length} kalem` +
            (d.plateNo ? `, plaka ${d.plateNo}` : "") +
            (d.ettn ? ", e-İrsaliye üretildi" : ", e-İrsaliye YOK"),
        }),
      ),
      ...invoiceLines.map(
        (l): FlowNode => ({
          kind: "fatura",
          documentNo: l.invoice.documentNo,
          date: l.invoice.issuedAt.toISOString().slice(0, 10),
          status: l.invoice.status,
          amount: Number(l.invoice.totalAmount),
          detail: l.invoice.ettn ? "e-Fatura üretildi" : "e-Fatura YOK",
        }),
      ),
      ...payments.map(
        (p): FlowNode => ({
          kind: "odeme",
          documentNo: p.payment.documentNo,
          date: p.payment.paidAt.toISOString().slice(0, 10),
          status: p.payment.direction,
          amount: Number(p.amount),
          detail: `${p.payment.method}, ${p.invoiceNo} faturasına`,
        }),
      ),
    ];

    // EKSİK HALKALAR AÇIKÇA SÖYLENİR.
    const gaps: string[] = [];
    const deliveredQty = order.lines.reduce((s, l) => s + Number(l.deliveredQty), 0);
    const orderedQty = order.lines.reduce((s, l) => s + Number(l.quantity), 0);
    const invoicedQty = order.lines.reduce((s, l) => s + Number(l.invoicedQty), 0);

    if (deliveredQty < orderedQty) {
      gaps.push(
        `Sipariş edilen ${orderedQty}, sevk edilen ${deliveredQty}; ` +
          `${Math.round((orderedQty - deliveredQty) * 10000) / 10000} birim henüz gitmedi.`,
      );
    }
    if (invoicedQty < deliveredQty) {
      gaps.push(
        `Sevk edilen ${deliveredQty}, faturalanan ${invoicedQty}; ` +
          `${Math.round((deliveredQty - invoicedQty) * 10000) / 10000} birim FATURALANMAMIŞ. ` +
          `Mal çıkmış ama gelir yazılmamış.`,
      );
    }
    const undocumented = order.deliveries.filter((d) => d.status === "posted" && !d.ettn);
    if (undocumented.length > 0) {
      gaps.push(
        `${undocumented.length} irsaliyenin e-İrsaliye belgesi YOK ` +
          `(${undocumented.map((d) => d.documentNo).join(", ")}). Belgesiz sevkiyat, ` +
          `yol denetiminde özel usulsüzlük cezası doğurur.`,
      );
    }
    if (invoiceNos.length > 0 && payments.length === 0) {
      gaps.push(`${invoiceNos.length} fatura kesilmiş ama hiç tahsilat kaydı yok.`);
    }

    return { root, upstream, downstream, gaps };
  }

  async #fromQuotation(documentNo: string): Promise<DocumentFlow> {
    const q = await this.#db.salesQuotation.findUniqueOrThrow({
      where: { documentNo },
      include: { lines: true },
    });
    if (q.salesOrderNo) {
      const flow = await this.#fromOrder(q.salesOrderNo);
      return {
        root: {
          kind: "teklif",
          documentNo: q.documentNo,
          date: q.quotedAt.toISOString().slice(0, 10),
          status: q.status,
          amount: null,
          detail: `${q.lines.length} kalem`,
        },
        upstream: [],
        downstream: [flow.root, ...flow.downstream],
        gaps: flow.gaps,
      };
    }
    return {
      root: {
        kind: "teklif",
        documentNo: q.documentNo,
        date: q.quotedAt.toISOString().slice(0, 10),
        status: q.status,
        amount: null,
        detail: `${q.lines.length} kalem`,
      },
      upstream: [],
      downstream: [],
      gaps:
        q.status === "ordered"
          ? []
          : [`Bu teklif henüz siparişe dönüşmedi (durum: ${q.status}).`],
    };
  }

  async #fromDelivery(documentNo: string): Promise<DocumentFlow> {
    const d = await this.#db.delivery.findUniqueOrThrow({
      where: { documentNo },
      include: { salesOrder: true },
    });
    const flow = await this.#fromOrder(d.salesOrder.orderNo);
    return {
      root: flow.downstream.find((n) => n.documentNo === documentNo) ?? flow.root,
      upstream: [...flow.upstream, flow.root],
      downstream: flow.downstream.filter(
        (n) => n.documentNo !== documentNo && n.kind !== "irsaliye",
      ),
      gaps: flow.gaps,
    };
  }

  async #fromInvoice(documentNo: string): Promise<DocumentFlow> {
    const inv = await this.#db.salesInvoice.findUniqueOrThrow({ where: { documentNo } });
    if (!inv.salesOrderId) {
      return {
        root: {
          kind: "fatura",
          documentNo,
          date: inv.issuedAt.toISOString().slice(0, 10),
          status: inv.status,
          amount: Number(inv.totalAmount),
          detail: "Siparişe bağlı değil",
        },
        upstream: [],
        downstream: [],
        gaps: ["Bu fatura hiçbir siparişe bağlı değil; zinciri izlenemiyor."],
      };
    }
    const order = await this.#db.salesOrder.findUniqueOrThrow({ where: { id: inv.salesOrderId } });
    const flow = await this.#fromOrder(order.orderNo);
    return {
      root: flow.downstream.find((n) => n.documentNo === documentNo) ?? flow.root,
      upstream: [...flow.upstream, flow.root, ...flow.downstream.filter((n) => n.kind === "irsaliye")],
      downstream: flow.downstream.filter((n) => n.kind === "odeme"),
      gaps: flow.gaps,
    };
  }

  async #fromPayment(documentNo: string): Promise<DocumentFlow> {
    const p = await this.#db.payment.findUniqueOrThrow({
      where: { documentNo },
      include: { allocations: true },
    });
    return {
      root: {
        kind: "odeme",
        documentNo,
        date: p.paidAt.toISOString().slice(0, 10),
        status: p.direction,
        amount: Number(p.amount),
        detail: `${p.method}, ${p.allocations.length} faturaya dağıtıldı`,
      },
      upstream: p.allocations.map(
        (a): FlowNode => ({
          kind: "fatura",
          documentNo: a.invoiceNo,
          date: p.paidAt.toISOString().slice(0, 10),
          status: "-",
          amount: Number(a.amount),
          detail: "Bu ödemeyle kapatılan fatura",
        }),
      ),
      downstream: [],
      gaps: [],
    };
  }
}
