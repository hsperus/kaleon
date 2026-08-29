/**
 * Master Data tool'ları.
 *
 * `resolve_partner` çekirdek tool'dur ve modelin en sık çağıracağı şeydir:
 * kullanıcı "Burçelik" der, model önce varlığı çözer, sonra o partner_id ile
 * finans/belge tool'larını çağırır. Bu zincir kurulmazsa tüm cevaplar yanlış olur.
 *
 * Belirsiz eşleşme "hata" değildir — modelin kullanıcıya sorması gereken
 * meşru bir durumdur. Bu yüzden `review` sonucu `ok: true` döner ve içinde
 * adaylar taşınır; model hangi firmanın kastedildiğini sorar.
 */

import { z } from "zod";
import { defineTool } from "../../kernel/tool.js";
import type { DataSource } from "../../data/port.js";
import type { ToolOk } from "../../kernel/types.js";
import { resolvePartner, type Resolution } from "./resolver.js";

export function masterDataTools(db: DataSource) {
  const resolvePartnerTool = defineTool({
    name: "resolve_partner",
    module: "master-data",
    authority: 0,
    deferLoading: false,
    description: {
      tr: "Serbest metinden geçen firma adını, vergi numarasını veya entegratör kimliğini KAELON'daki tek partner kaydına çözer. Bir tedarikçi/müşteri hakkında herhangi bir sorgu yapmadan ÖNCE bunu çağır — 'Burçelik', 'BURÇELİK A.Ş.' ve vergi numarası aynı firmadır. Sonuç belirsizse adaylar döner; kullanıcıya hangisini kastettiğini sor.",
      en: "Resolves a free-text company name, tax ID or integrator reference to a single canonical partner record. Call before any supplier/customer query. Returns candidates when ambiguous.",
    },
    input: z.strictObject({
      name: z.string().min(2).nullable().describe("Firma adı veya bir bölümü. Yoksa null."),
      taxId: z.string().min(10).nullable().describe("VKN (10 hane) veya TCKN (11 hane). Yoksa null."),
      externalSystem: z.string().min(2).nullable().describe("Entegratör adı, örn. 'uyumsoft'. Yoksa null."),
      externalId: z.string().min(1).nullable().describe("Entegratördeki cari kimlik. Yoksa null."),
    }),
    requires: ["master-data:partner.read"],
    async execute(input, ctx): Promise<ToolOk<Resolution>> {
      const externalRef =
        input.externalSystem && input.externalId
          ? { system: input.externalSystem, externalId: input.externalId }
          : null;

      const { rows, freshness } = await db.partnerCandidates(ctx.tenant.tenantId, {
        name: input.name,
        taxId: input.taxId,
        externalRef,
      });

      const resolution: Resolution = resolvePartner(
        {
          name: input.name,
          taxId: input.taxId,
          externalRef,
        },
        rows,
      );

      const sources = [
        {
          system: "Master Data · Entity Resolution",
          kind: "derived" as const,
          recordCount: freshness.recordCount,
          syncedAt: freshness.syncedAt,
        },
      ];

      if (resolution.status === "resolved") {
        return {
          ok: true as const,
          data: resolution,
          sources,
          confidence: Math.round(resolution.match.confidence * 100),
        };
      }

      if (resolution.status === "review") {
        return {
          ok: true as const,
          data: resolution,
          sources,
          risks: [
            {
              severity: "warning" as const,
              message:
                `Firma tek anlamlı olarak çözülemedi. ${resolution.reason} ` +
                `Kullanıcıya hangi firmayı kastettiğini sor; kendin seçme.`,
            },
          ],
          confidence: Math.round((resolution.candidates[0]?.confidence ?? 0) * 100),
        };
      }

      return {
        ok: true as const,
        data: resolution,
        sources,
        risks: [
          {
            severity: "info" as const,
            message:
              "Bu ada/numaraya karşılık gelen bir firma kaydı yok. " +
              "Yeni cari açılması gerekebilir; uydurma bir sonuç verme.",
          },
        ],
        confidence: 100,
      };
    },
  });

  return [resolvePartnerTool] as const;
}
