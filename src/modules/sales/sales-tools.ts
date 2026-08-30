/**
 * Satış zinciri tool'ları.
 *
 * YETKİ SEVİYELERİ BELGENİN GERİ ALINABİLİRLİĞİNE GÖRE:
 *   L0 okuma            — sipariş ve irsaliye görüntüleme
 *   L1 sevkiyat kaydı   — ileri yönlü, depo sorumlusunun günlük işi.
 *                         `post_stock_movement` ile aynı seviyede: normal
 *                         bir stok çıkışıdır ve aşırı sevkiyat koruması
 *                         yetkiyle değil BELGE ZİNCİRİYLE sağlanır.
 *   L2 sevkiyat iptali  — ters stok kaydı üretir; `reverse_stock_movement`
 *                         ile aynı seviyede. Geri alma her zaman ileri
 *                         işlemden bir seviye yukarıdadır: hatayı yapan
 *                         kişi tek başına silemesin.
 *   L3 fatura kesme     — MEVZUAT KARŞISINDA BELGEDİR. Kesildikten sonra
 *                         değiştirilemez, yalnızca iptal edilebilir ve
 *                         iptal de vergi dairesine yansır. Geri alınamaz
 *                         sayılır ve en üst onayı ister.
 *
 * FATURA TOOL'U SİPARİŞ DEĞİL SEVKİYAT ALIR. Model "şu siparişi faturala"
 * diyemez; hangi irsaliyenin faturalanacağını göstermek zorundadır. Bu,
 * modelin sevk edilmemiş malı faturalamasını arayüz seviyesinde de
 * imkânsız kılar.
 */

import { z } from "zod";
import { defineTool } from "../../kernel/tool.js";
import type { SalesRepository } from "../../db/sales-repository.js";
import { deliverableQty, invoiceableQty } from "./o2c.js";

const TRY_FORMAT = new Intl.NumberFormat("tr-TR", { minimumFractionDigits: 2 });

function money(n: number, currency: string): string {
  return `${TRY_FORMAT.format(n)} ${currency === "TRY" ? "TL" : currency}`;
}

export function salesTools(repo: SalesRepository) {
  const getOrder = defineTool({
    name: "get_sales_order",
    module: "sales",
    authority: 0,
    description: {
      tr:
        "Bir satış siparişinin tamamını döndürür: müşteri, termin, kalemler, " +
        "her kalemde SİPARİŞ EDİLEN / SEVK EDİLEN / FATURALANAN miktarlar, " +
        "fiyat ve tutarlar. 'Bu sipariş ne durumda', 'ne kadarı gitti', " +
        "'kaçı faturalandı' sorularında kullan.",
      en: "Returns a sales order with ordered/delivered/invoiced quantities and amounts.",
    },
    input: z.strictObject({
      orderNo: z.string().min(1).max(64).describe("Sipariş numarası."),
    }),
    requires: ["sales:order.read"],
    async execute(input, _ctx) {
      const order = await repo.orderByNo(input.orderNo);
      if (!order) {
        return {
          ok: true as const,
          data: null,
          sources: [
            {
              system: "Satış siparişleri",
              kind: "module" as const,
              recordCount: 0,
              syncedAt: new Date().toISOString(),
            },
          ],
          risks: [
            {
              severity: "warning" as const,
              message: `"${input.orderNo}" numaralı sipariş bulunamadı.`,
            },
          ],
          confidence: 90,
        };
      }

      const unpriced = order.lines.filter((l) => l.unitPrice <= 0);
      const openLines = order.lines.filter((l) => deliverableQty(l) > 1e-9);

      return {
        ok: true as const,
        data: {
          orderNo: order.orderNo,
          customer: order.partnerName,
          committedDate: order.committedDate,
          status: order.status,
          currency: order.currency,
          overDeliveryTolerance: order.overDeliveryTolerance,
          lines: order.lines.map((l) => ({
            lineNo: l.lineNo,
            item: l.itemCode,
            uom: l.uom,
            orderedQty: l.orderedQty,
            deliveredQty: l.deliveredQty,
            invoicedQty: l.invoicedQty,
            remainingToShip: deliverableQty(l),
            remainingToInvoice: invoiceableQty(l),
            unitPrice: l.unitPrice > 0 ? l.unitPrice : null,
            vatRate: l.vatRate,
          })),
          netAmount: order.netAmount,
          vatAmount: order.vatAmount,
          totalAmount: order.totalAmount,
          amountLabel: money(order.totalAmount, order.currency),
        },
        sources: [
          {
            system: "Satış siparişleri",
            kind: "module" as const,
            recordCount: order.lines.length,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks: [
          // FİYATSIZ KALEM TUTARI EKSİK GÖSTERİR VE BU SÖYLENİR.
          // Söylenmezse kullanıcı gördüğü toplamı siparişin tamamı sanar.
          ...(unpriced.length > 0
            ? [
                {
                  severity: "warning" as const,
                  message:
                    `${unpriced.length} kalemde fiyat girilmemiş (${unpriced
                      .map((l) => l.itemCode)
                      .join(", ")}); gösterilen tutar bu kalemleri İÇERMİYOR.`,
                },
              ]
            : []),
          ...(openLines.length === 0 && order.status !== "cancelled"
            ? [
                {
                  severity: "info" as const,
                  message: "Siparişin tamamı sevk edilmiş; sevk edilecek kalem kalmadı.",
                },
              ]
            : []),
        ],
        confidence: unpriced.length > 0 ? 80 : 96,
      };
    },
  });

  const postDelivery = defineTool({
    name: "post_delivery",
    module: "sales",
    authority: 1,
    description: {
      tr:
        "Sevk irsaliyesi keser: malı stoktan düşer, sipariş kaleminin sevk " +
        "edilen miktarını artırır ve sipariş durumunu günceller. Miktar " +
        "sipariş edilenden fazla olamaz (aşırı sevkiyat toleransı siparişte " +
        "tanımlıdır). Kısmi sevkiyat normaldir. 'Şu siparişten 60 adet " +
        "gönderdik' denince kullan.",
      en: "Posts a delivery note: reduces stock and advances the order.",
    },
    input: z.strictObject({
      orderNo: z.string().min(1).max(64).describe("Sipariş numarası."),
      locationId: z.string().min(1).max(64).describe("Malın çıktığı depo."),
      shippedAt: z.string().describe("Sevk tarihi (ISO 8601)."),
      carrierName: z.string().max(200).nullable().describe("Taşıyıcı firma. Yoksa null."),
      plateNo: z.string().max(20).nullable().describe("Araç plakası. Yoksa null."),
      lines: z
        .array(
          z.strictObject({
            orderLineNo: z.number().int().positive().describe("Sipariş kalem numarası."),
            quantity: z.number().positive().describe("Sevk miktarı — temel birimde."),
            batchId: z.string().max(64).nullable().describe("Parti numarası. Yoksa null."),
          }),
        )
        .min(1)
        .describe("Sevk edilen kalemler. Her kalem YALNIZCA BİR KEZ geçebilir."),
    }),
    requires: ["sales:delivery.write"],
    async execute(input, ctx) {
      const res = await repo.postDelivery({
        orderNo: input.orderNo,
        locationId: input.locationId,
        shippedAt: new Date(input.shippedAt),
        userId: ctx.principal.userId,
        carrierName: input.carrierName,
        plateNo: input.plateNo,
        lines: input.lines.map((l) => ({
          orderLineNo: l.orderLineNo,
          quantity: l.quantity,
          batchId: l.batchId,
        })),
      });

      return {
        ok: true as const,
        data: {
          documentNo: res.documentNo,
          orderNo: input.orderNo,
          lineCount: res.lines,
          orderStatus: res.orderStatus,
        },
        sources: [
          {
            system: "Sevk irsaliyesi",
            kind: "module" as const,
            recordCount: res.lines,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks: [
          {
            severity: "info" as const,
            message:
              `${res.documentNo} kesildi; stok düşüldü. Sipariş durumu: ${res.orderStatus}. ` +
              `Fatura bu irsaliyeye dayanarak kesilir.`,
          },
        ],
        confidence: 98,
      };
    },
  });

  const cancelDelivery = defineTool({
    name: "cancel_delivery",
    module: "sales",
    authority: 2,
    description: {
      tr:
        "Sevk irsaliyesini iptal eder: stok hareketinin TERSİNİ yazar ve " +
        "sipariş kaleminin sevk edilen miktarını geri alır. Hareket silinmez, " +
        "iptal kaydı iz olarak kalır. FATURALANMIŞ irsaliye iptal edilemez; " +
        "önce iade faturası gerekir.",
      en: "Cancels a delivery note by writing a reversing stock movement.",
    },
    input: z.strictObject({
      documentNo: z.string().min(1).max(64).describe("İrsaliye numarası."),
      reason: z.string().min(3).max(300).describe("İptal sebebi — kayda geçer."),
    }),
    requires: ["sales:delivery.cancel"],
    async execute(input, ctx) {
      const status = await repo.cancelDelivery(input.documentNo, ctx.principal.userId, input.reason);
      return {
        ok: true as const,
        data: { documentNo: input.documentNo, orderStatus: status },
        sources: [
          {
            system: "Sevk irsaliyesi",
            kind: "module" as const,
            recordCount: 1,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks: [
          {
            severity: "warning" as const,
            message:
              `${input.documentNo} iptal edildi; stok ters kayıtla geri alındı. ` +
              `Sipariş durumu: ${status}.`,
          },
        ],
        confidence: 98,
      };
    },
  });

  const issueInvoice = defineTool({
    name: "issue_sales_invoice",
    module: "sales",
    authority: 3,
    description: {
      tr:
        "SEVK EDİLMİŞ mallardan satış faturası keser. Kaynak olarak irsaliye " +
        "kalemleri verilir — sipariş değil; sevk edilmemiş mal faturalanamaz. " +
        "Fiyat sipariş kaleminden gelir, KDV satır bazında hesaplanır. " +
        "KESİLEN FATURA DEĞİŞTİRİLEMEZ, yalnızca iptal edilebilir.",
      en: "Issues a sales invoice from delivered quantities. Immutable once issued.",
    },
    input: z.strictObject({
      sources: z
        .array(
          z.strictObject({
            deliveryId: z.string().min(1).describe("İrsaliye kimliği."),
            deliveryLineNo: z.number().int().positive().describe("İrsaliye kalem numarası."),
          }),
        )
        .min(1)
        .describe("Faturalanacak irsaliye kalemleri. Hepsi AYNI müşteri ve siparişten olmalı."),
      issuedAt: z.string().describe("Fatura tarihi (ISO 8601)."),
      dueDate: z.string().nullable().describe("Vade tarihi (ISO 8601). Yoksa null."),
      exchangeRate: z
        .number()
        .positive()
        .nullable()
        .describe("Yabancı para faturada TL kuru. TL faturada null."),
    }),
    requires: ["sales:invoice.write"],
    async execute(input, ctx) {
      const res = await repo.issueInvoice({
        sources: input.sources,
        issuedAt: new Date(input.issuedAt),
        dueDate: input.dueDate ? new Date(input.dueDate) : null,
        userId: ctx.principal.userId,
        ...(input.exchangeRate !== null ? { exchangeRate: input.exchangeRate } : {}),
      });

      return {
        ok: true as const,
        data: {
          documentNo: res.documentNo,
          totalAmount: res.totalAmount,
          orderStatus: res.orderStatus,
        },
        sources: [
          {
            system: "Satış faturaları",
            kind: "module" as const,
            recordCount: input.sources.length,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks: [
          {
            severity: "warning" as const,
            message:
              `${res.documentNo} kesildi (${TRY_FORMAT.format(res.totalAmount)}). ` +
              `Fatura artık DEĞİŞTİRİLEMEZ; hatalıysa iptal edilip yenisi kesilmelidir.`,
          },
        ],
        confidence: 98,
      };
    },
  });

  return [getOrder, postDelivery, cancelDelivery, issueInvoice] as const;
}
