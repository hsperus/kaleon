/**
 * Satın alma talebi ve ödeme tool'ları.
 *
 * ONAY TOOL'U ROLLERİ ÇAĞRI ANINDA OKUR, girdiden almaz. Girdiden alsaydı,
 * model kendi rolünü "patron" diye yazıp her tutarı onaylatabilirdi —
 * yetki kontrolünü modele sormak, kontrolü hiç yapmamaktır.
 *
 * ÖDEME L3'TÜR. Para çıkışı geri alınamaz: yanlış tedarikçiye giden bir
 * havale, iyi niyetle geri istenir ve genellikle geri gelmez.
 */

import { z } from "zod";
import { defineTool } from "../../kernel/tool.js";
import type { ProcurementRepository } from "../../db/procurement-repository.js";
import { APPROVAL_THRESHOLDS } from "./requisition.js";
import { PAYMENT_METHODS } from "../finance/payment.js";

const TR = new Intl.NumberFormat("tr-TR", { minimumFractionDigits: 2 });

export function procurementTools(repo: ProcurementRepository) {
  const createRequisition = defineTool({
    name: "create_purchase_requisition",
    module: "documents",
    authority: 1,
    description: {
      tr:
        "Satın alma talebi açar. Talep SİPARİŞ DEĞİLDİR: onaylanmadan siparişe " +
        "dönüşmez ve talep eden onaylayamaz. Tahmini fiyat girilmezse onay eşiği " +
        "hesaplanamaz ve talep onaylanamaz — fiyatsız kalem, talebi gerçekte " +
        "gerektirdiğinden düşük bir onay seviyesine düşürür.",
      en: "Creates a purchase requisition (not an order; requires separate approval).",
    },
    input: z.strictObject({
      justification: z.string().min(5).max(500).describe("Neden gerekiyor?"),
      department: z.string().max(80).nullable().describe("Talep eden departman."),
      lines: z
        .array(
          z.strictObject({
            itemCode: z.string().min(1).max(64),
            quantity: z.number().positive(),
            uom: z.string().min(1).max(16),
            estimatedPrice: z
              .number()
              .nonnegative()
              .nullable()
              .describe("Tahmini birim fiyat, TL. BİLİNMİYORSA null — sıfır yazma."),
            neededBy: z.string().describe("Ne zamana gerekiyor (ISO 8601)."),
          }),
        )
        .min(1),
    }),
    requires: ["documents:requisition.draft"],
    async execute(input, ctx) {
      const req = await repo.createRequisition({
        requestedBy: ctx.principal.userId,
        department: input.department,
        justification: input.justification,
        at: ctx.now(),
        lines: input.lines.map((l) => ({
          itemCode: l.itemCode,
          quantity: l.quantity,
          uom: l.uom,
          estimatedPrice: l.estimatedPrice,
          neededBy: new Date(l.neededBy),
        })),
      });

      return {
        ok: true as const,
        data: {
          documentNo: req.documentNo,
          status: req.status,
          estimatedTotal: req.estimatedTotal,
          requiredApprover: req.requiredApprover,
        },
        sources: [
          {
            system: "Satın alma talepleri",
            kind: "module" as const,
            recordCount: req.lines.length,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks: [
          ...(req.unpricedLines.length > 0
            ? [
                {
                  severity: "warning" as const,
                  message:
                    `${req.unpricedLines.join(", ")}. kalemlerde tahmini fiyat yok. ` +
                    `Bu hâliyle talep ONAYLANAMAZ; fiyatsız kalem onay eşiğini ` +
                    `olduğundan düşük gösterir.`,
                },
              ]
            : []),
          {
            severity: "info" as const,
            message:
              `${req.documentNo} açıldı (${TR.format(req.estimatedTotal ?? 0)} TL tahmini). ` +
              `Onay için gereken seviye: ${req.requiredApprover}. Talebi siz onaylayamazsınız.`,
          },
        ],
        confidence: req.unpricedLines.length > 0 ? 75 : 96,
      };
    },
  });

  const approve = defineTool({
    name: "approve_purchase_requisition",
    module: "documents",
    authority: 2,
    description: {
      tr:
        "Satın alma talebini onaylar. KENDİ TALEBİNİZİ ONAYLAYAMAZSINIZ ve onay " +
        `seviyesi tutara göre değişir: ${TR.format(APPROVAL_THRESHOLDS[0]!.upTo)} TL'ye ` +
        `kadar satın alma, ${TR.format(APPROVAL_THRESHOLDS[1]!.upTo)} TL'ye kadar CFO, ` +
        "üstü patron.",
      en: "Approves a purchase requisition. Self-approval is impossible.",
    },
    input: z.strictObject({
      documentNo: z.string().min(1).max(64).describe("Talep numarası."),
    }),
    requires: ["approval:procurement.approve"],
    async execute(input, ctx) {
      // ROLLER ÇAĞRI ANINDA OKUNUR, girdiden alınmaz.
      const req = await repo.approveRequisition({
        documentNo: input.documentNo,
        approverId: ctx.principal.userId,
        approverRoles: ctx.principal.roles,
      });

      return {
        ok: true as const,
        data: {
          documentNo: req.documentNo,
          status: req.status,
          estimatedTotal: req.estimatedTotal,
        },
        sources: [
          {
            system: "Satın alma talepleri",
            kind: "module" as const,
            recordCount: 1,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks: [
          {
            severity: "info" as const,
            message: `${req.documentNo} onaylandı; artık siparişe dönüştürülebilir.`,
          },
        ],
        confidence: 98,
      };
    },
  });

  const getRequisition = defineTool({
    name: "get_purchase_requisition",
    module: "documents",
    authority: 0,
    description: {
      tr:
        "Satın alma talebinin durumunu, kalemlerini, tahmini tutarını ve hangi " +
        "seviyede onay gerektiğini döndürür.",
      en: "Returns a purchase requisition with its lines and required approval level.",
    },
    input: z.strictObject({
      documentNo: z.string().min(1).max(64).describe("Talep numarası."),
    }),
    requires: ["documents:requisition.read"],
    async execute(input, _ctx) {
      const req = await repo.requisitionByNo(input.documentNo);
      return {
        ok: true as const,
        data: req,
        sources: [
          {
            system: "Satın alma talepleri",
            kind: "module" as const,
            recordCount: req ? req.lines.length : 0,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks: req
          ? req.unpricedLines.length > 0
            ? [
                {
                  severity: "warning" as const,
                  message: `${req.unpricedLines.join(", ")}. kalemlerde fiyat yok; talep onaylanamaz.`,
                },
              ]
            : []
          : [
              {
                severity: "warning" as const,
                message: `"${input.documentNo}" numaralı talep bulunamadı.`,
              },
            ],
        confidence: req ? 96 : 90,
      };
    },
  });

  const convert = defineTool({
    name: "convert_requisition_to_order",
    module: "documents",
    authority: 2,
    description: {
      tr:
        "ONAYLI talebi satın alma siparişine dönüştürür. Onaylanmamış talep " +
        "dönüştürülemez; aynı talep iki kez siparişe çevrilemez.",
      en: "Converts an approved requisition into a purchase order.",
    },
    input: z.strictObject({
      documentNo: z.string().min(1).max(64).describe("Talep numarası."),
      partnerId: z.string().min(1).describe("Tedarikçi kimliği."),
      currency: z.string().min(3).max(3).describe("Sipariş para birimi."),
    }),
    requires: ["documents:po.draft"],
    async execute(input, ctx) {
      const res = await repo.convertToOrder({
        documentNo: input.documentNo,
        partnerId: input.partnerId,
        orderedAt: ctx.now(),
        currency: input.currency.toUpperCase(),
      });
      return {
        ok: true as const,
        data: { requisitionNo: input.documentNo, ...res },
        sources: [
          {
            system: "Satın alma siparişleri",
            kind: "module" as const,
            recordCount: res.lines,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks: [
          {
            severity: "info" as const,
            message: `${res.purchaseOrderId} siparişi açıldı (${res.lines} kalem).`,
          },
        ],
        confidence: 97,
      };
    },
  });

  const payables = defineTool({
    name: "list_open_payables",
    module: "finance",
    authority: 0,
    description: {
      tr:
        "Ödenmemiş tedarikçi faturalarını listeler; en eski başta. Mutabakat " +
        "farkı nedeniyle BLOKE faturalar listelenmez — onlar ödenmeden önce " +
        "farkın çözülmesi gerekir.",
      en: "Lists open supplier invoices, oldest first. Blocked invoices are excluded.",
    },
    input: z.strictObject({
      limit: z.number().int().positive().max(200).describe("Kaç kayıt döndürülsün."),
    }),
    requires: ["finance:payment.read"],
    async execute(input, ctx) {
      const rows = await repo.openPayables(ctx.now(), input.limit);
      const total = rows.reduce((s, r) => s + r.openAmount, 0);
      return {
        ok: true as const,
        data: {
          invoices: rows,
          totalOpen: Math.round(total * 100) / 100,
          totalLabel: `${TR.format(total)} TL`,
        },
        sources: [
          {
            system: "Gelen faturalar",
            kind: "module" as const,
            recordCount: rows.length,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks:
          rows.length > 0
            ? [
                {
                  severity: "info" as const,
                  message:
                    `Toplam ${TR.format(total)} TL ödenmemiş fatura var; en eskisi ` +
                    `${rows[0]!.ageDays} günlük. Bloke faturalar bu listeye DAHİL DEĞİL.`,
                },
              ]
            : [],
        confidence: 94,
      };
    },
  });

  const pay = defineTool({
    name: "post_payment",
    module: "finance",
    authority: 3,
    description: {
      tr:
        "Ödeme kaydeder ve faturalara dağıtır. Ödeme tutarının TAMAMI faturalara " +
        "dağıtılmalıdır — dağıtılmayan tutar hiçbir faturaya bağlanmaz ve " +
        "mutabakatta çözülemez. BLOKE fatura ödenemez; fatura tutarından fazlası " +
        "ödenemez. Bu bir KAYITTIR, bankaya talimat göndermez.",
      en: "Records a payment and allocates it to invoices. Does not instruct a bank.",
    },
    input: z.strictObject({
      direction: z
        .enum(["outgoing", "incoming"])
        .describe("outgoing: tedarikçiye ödeme. incoming: müşteriden tahsilat."),
      partnerId: z.string().min(1).describe("Cari kimliği."),
      amount: z.number().positive().describe("Ödeme tutarı."),
      currency: z.string().min(3).max(3).describe("Para birimi."),
      method: z.enum(PAYMENT_METHODS).describe("Ödeme şekli."),
      paidAt: z.string().describe("Ödeme tarihi (ISO 8601)."),
      reference: z.string().max(120).nullable().describe("Dekont/çek numarası."),
      allocations: z
        .array(
          z.strictObject({
            invoiceNo: z.string().min(1).max(64),
            amount: z.number().positive(),
          }),
        )
        .min(1)
        .describe("Hangi faturaya ne kadar. Toplamı ödeme tutarına EŞİT olmalıdır."),
    }),
    requires: ["finance:payment.write"],
    async execute(input, ctx) {
      const res = await repo.postPayment({
        direction: input.direction,
        partnerId: input.partnerId,
        amount: input.amount,
        currency: input.currency.toUpperCase(),
        method: input.method,
        paidAt: new Date(input.paidAt),
        userId: ctx.principal.userId,
        reference: input.reference,
        allocations: input.allocations,
      });

      return {
        ok: true as const,
        data: {
          documentNo: res.documentNo,
          amount: input.amount,
          allocated: res.allocated,
          closedInvoices: res.closedInvoices,
        },
        sources: [
          {
            system: "Ödemeler",
            kind: "module" as const,
            recordCount: res.allocated,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks: [
          {
            severity: "warning" as const,
            message:
              `${res.documentNo}: ${TR.format(input.amount)} ${input.currency} ödeme kaydedildi, ` +
              `${res.allocated} faturaya dağıtıldı` +
              (res.closedInvoices.length > 0
                ? `; ${res.closedInvoices.join(", ")} tamamen kapandı.`
                : ".") +
              " Bu bir KAYITTIR; bankaya talimat GÖNDERİLMEDİ.",
          },
        ],
        confidence: 97,
      };
    },
  });

  return [createRequisition, getRequisition, approve, convert, payables, pay] as const;
}
