/**
 * İade ve dekont tool'ları.
 *
 * İADE L2'DİR. Mali sonuç doğurur (KDV düzeltmesi), cari bakiyesini
 * değiştirir ve stok girişi yaratır; geri alınması ters belge
 * gerektirir. Faturayı kesen kişiden AYRI bir yetki değildir ama
 * onaydan geçer.
 */

import { z } from "zod";
import { defineTool } from "../../kernel/tool.js";
import type { CreditNoteRepository, NoteKind } from "../../db/credit-note-repository.js";

const TR = new Intl.NumberFormat("tr-TR", { minimumFractionDigits: 2 });
const money = (n: number, cur = "TL"): string => `${TR.format(n)} ${cur}`;

const KIND_LABEL: Record<NoteKind, string> = {
  iade: "satış iadesi",
  alacak_dekontu: "alacak dekontu",
  borc_dekontu: "borç dekontu",
};

export function creditNoteTools(repo: CreditNoteRepository) {
  const read = defineTool({
    name: "get_credit_note",
    module: "sales",
    authority: 0,
    description: {
      tr:
        "Bir iade ya da dekont belgesini okur: kalemler, tutarlar, gerekçe ve hangi " +
        "faturaya bağlı olduğu. 'İade belgesini göster', 'dekontu aç' sorularında kullan.",
      en: "Reads a sales return or credit/debit note document.",
    },
    input: z.strictObject({
      documentNo: z.string().min(1).max(64).describe("İade/dekont numarası."),
    }),
    requires: ["sales:order.read"],
    async execute(input, _ctx) {
      const n = await repo.byDocumentNo(input.documentNo);
      if (!n) {
        return {
          ok: true as const,
          data: null,
          sources: [
            {
              system: "İade ve dekontlar",
              kind: "module" as const,
              recordCount: 0,
              syncedAt: new Date().toISOString(),
            },
          ],
          risks: [
            {
              severity: "warning" as const,
              message: `"${input.documentNo}" numaralı iade/dekont bulunamadı.`,
            },
          ],
          confidence: 90,
        };
      }
      return {
        ok: true as const,
        data: {
          kind: "credit-note" as const,
          note: n,
          summary:
            `${n.documentNo}: ${KIND_LABEL[n.kind]}, ${money(n.totalAmount, n.currency)}, ` +
            `${n.invoiceNo ?? "faturasız"}.`,
        },
        sources: [
          {
            system: "İade ve dekontlar",
            kind: "module" as const,
            recordCount: n.lines.length,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks: [],
        confidence: 97,
      };
    },
  });

  const listForInvoice = defineTool({
    name: "list_invoice_credit_notes",
    module: "sales",
    authority: 0,
    description: {
      tr:
        "Bir faturaya kesilmiş TÜM iade ve dekontları listeler. 'Bu faturaya iade " +
        "var mı', 'faturanın iadelerini göster', 'faturadan ne kadar düşüldü' " +
        "sorularında kullan. Faturanın net tutarını anlamak için gerekir: " +
        "100.000 TL'lik faturadan 30.000 TL iade edilmişse müşterinin gerçek borcu " +
        "70.000 TL'dir. BELGE ZİNCİRİNDEN (get_document_flow) FARKLIDIR: zincir " +
        "siparişten tahsilata giden yolu gösterir, bu tool faturayı AZALTAN " +
        "belgeleri gösterir.",
      en: "Lists all returns and credit notes issued against an invoice.",
    },
    input: z.strictObject({
      invoiceNo: z.string().min(1).max(64).describe("Fatura numarası."),
    }),
    requires: ["sales:order.read"],
    async execute(input, _ctx) {
      const rows = await repo.listForInvoice(input.invoiceNo);
      const total = rows.reduce(
        (s, r) => s + (r.kind === "borc_dekontu" ? -r.totalAmount : r.totalAmount),
        0,
      );
      return {
        ok: true as const,
        data: {
          notes: rows,
          count: rows.length,
          netReduction: Math.round(total * 100) / 100,
          summary:
            rows.length === 0
              ? `${input.invoiceNo} faturasına kesilmiş iade/dekont yok.`
              : `${rows.length} belge, faturayı net ${money(total)} azaltıyor.`,
        },
        sources: [
          {
            system: "İade ve dekontlar",
            kind: "module" as const,
            recordCount: rows.length,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks: [],
        confidence: 96,
      };
    },
  });

  const issue = defineTool({
    name: "issue_credit_note",
    module: "sales",
    authority: 2,
    confirm: "always",
    description: {
      tr:
        "Satış iadesi ya da dekont keser ve MUHASEBE KAYDINI yazar. Üç tür: " +
        "'iade' mal geri geldiğinde (stok girer, 610 hesabı), 'alacak_dekontu' " +
        "mal gelmeden fiyat düşerse (611), 'borc_dekontu' müşteriye ek yansıtmada " +
        "(600). KESİLMİŞ FATURA İPTAL EDİLMEZ, İADE EDİLİR — ikisi denetimde " +
        "farklıdır. Faturalanandan fazla iade edilemez.",
      en: "Issues a sales return or credit/debit note and posts the journal entry.",
    },
    input: z.strictObject({
      kind: z
        .enum(["iade", "alacak_dekontu", "borc_dekontu"])
        .describe("Belge türü; muhasebe hesabı buna göre belirlenir."),
      invoiceNo: z.string().min(1).max(64).describe("Hangi faturaya karşılık."),
      issuedAt: z.string().describe("Belge tarihi (ISO 8601)."),
      reason: z.string().min(5).max(500).describe("Gerekçe — denetimde sorulur."),
      locationId: z
        .string()
        .max(64)
        .nullable()
        .describe("Mal iadesinde girilecek depo; dekontta null."),
      lines: z
        .array(
          z.strictObject({
            invoiceLineNo: z
              .number()
              .int()
              .nullable()
              .describe("Fatura satır numarası; iadede zorunlu."),
            quantity: z.number().describe("İade/dekont miktarı."),
            unitPrice: z
              .number()
              .nullable()
              .describe("Birim fiyat; null ise fatura fiyatı kullanılır."),
            description: z.string().max(200).nullable().describe("Açıklama; null ise fatura satırı."),
          }),
        )
        .max(200)
        .describe("Belge kalemleri."),
    }),
    requires: ["sales:invoice.issue"],
    async execute(input, ctx) {
      // MAL GERİ GELDİ Mİ, TÜRDEN ÇIKAR. Kullanıcıya ayrıca sormak,
      // "iade ama mal gelmedi" gibi tutarsız bir belgeye kapı açardı.
      const withGoods = input.kind === "iade";
      const n = await repo.issue({
        kind: input.kind,
        invoiceNo: input.invoiceNo,
        issuedAt: new Date(input.issuedAt),
        reason: input.reason,
        withGoods,
        locationId: input.locationId,
        userId: ctx.principal.userId,
        lines: input.lines.map((l) => ({
          invoiceLineNo: l.invoiceLineNo,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          description: l.description,
        })),
      });

      return {
        ok: true as const,
        data: {
          kind: "credit-note" as const,
          note: n,
          summary:
            `${n.documentNo} kesildi: ${KIND_LABEL[n.kind]}, ` +
            `${money(n.totalAmount, n.currency)} (yevmiye ${n.journalDocumentNo}).`,
        },
        sources: [
          {
            system: "İade ve dekontlar",
            kind: "module" as const,
            recordCount: n.lines.length,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks: [
          {
            severity: "info" as const,
            message:
              `${n.documentNo} için ${money(n.vatAmount, n.currency)} KDV düzeltmesi ` +
              `yapıldı; bu ayın KDV beyannamesine yansır.`,
          },
          ...(withGoods
            ? [
                {
                  severity: "info" as const,
                  message:
                    `${n.lines.length} kalem depoya giriş yaptı; iade edilen malın ` +
                    `durumu kontrol edilmeli (satılabilir mi, hurda mı).`,
                },
              ]
            : []),
        ],
        confidence: 96,
      };
    },
  });

  return [read, listForInvoice, issue] as const;
}
