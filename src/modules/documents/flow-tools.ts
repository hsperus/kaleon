/**
 * Belge zinciri tool'u.
 *
 * Bir ERP'de en sık kullanılan görünümlerden biri budur: "bu fatura
 * nereden geldi", "bu sipariş ne oldu". Bağlar tek tek vardı ama zincir
 * görünmüyordu; kullanıcı beş ayrı sorgu yapmak zorundaydı.
 */

import { z } from "zod";
import { defineTool } from "../../kernel/tool.js";
import type { DocumentFlowRepository } from "../../db/document-flow-repository.js";

export function flowTools(repo: DocumentFlowRepository) {
  const flow = defineTool({
    name: "get_document_flow",
    module: "documents",
    authority: 0,
    description: {
      tr:
        "Bir belgenin ZİNCİRİNİ döndürür: teklif → sipariş → irsaliye → fatura → " +
        "tahsilat. EKSİK HALKALAR ayrıca söylenir: sevk edilip faturalanmamış mal, " +
        "e-İrsaliyesi olmayan sevkiyat, kesilip tahsil edilmemiş fatura. " +
        "YALNIZCA 'bu belge nereden geldi', 'bu sipariş ne oldu', 'zinciri göster' " +
        "gibi İZ SÜRME sorularında kullan. Faturanın İÇERİĞİ, İADELERİ ya da " +
        "MUHASEBE KAYDI için bu tool DEĞİL, ilgili özel tool kullanılır " +
        "(get_invoice_document, list_invoice_credit_notes, " +
        "get_document_journal_entry).",
      en: "Returns the full document chain for any sales document, in both directions.",
    },
    input: z.strictObject({
      documentNo: z
        .string()
        .min(1)
        .max(64)
        .describe("Teklif, sipariş, irsaliye, fatura veya ödeme numarası."),
    }),
    requires: ["documents:flow.read"],
    async execute(input, _ctx) {
      const f = await repo.flowOf(input.documentNo);
      return {
        ok: true as const,
        data: {
          root: f.root,
          upstream: f.upstream,
          downstream: f.downstream,
          chainLength: 1 + f.upstream.length + f.downstream.length,
        },
        sources: [
          {
            system: "Belge zinciri",
            kind: "module" as const,
            recordCount: 1 + f.upstream.length + f.downstream.length,
            syncedAt: new Date().toISOString(),
          },
        ],
        // EKSİK HALKA SESSİZ GEÇİLMEZ: zincirdeki boşluk, zincirin
        // kendisinden daha önemli bir bilgidir.
        risks: f.gaps.map((g) => ({ severity: "warning" as const, message: g })),
        confidence: 95,
      };
    },
  });

  return [flow] as const;
}
