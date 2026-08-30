/**
 * Stok sayımı tool'ları.
 *
 * SAYIM AÇMAK L1, KAYDETMEK L2'DİR. Açmak yalnızca bir liste üretir ve
 * hiçbir şeyi değiştirmez; kaydetmek stoğu düzeltir ve muhasebeye fiş
 * atar — geri alınması ayrı bir düzeltme gerektirir.
 */

import { z } from "zod";
import { defineTool } from "../../kernel/tool.js";
import type { StockCountRepository } from "../../db/stock-count-repository.js";
import { RECOUNT_THRESHOLD_PERCENT } from "./stock-count.js";

const TR = new Intl.NumberFormat("tr-TR", { minimumFractionDigits: 2 });

export function stockCountTools(repo: StockCountRepository) {
  const open = defineTool({
    name: "open_stock_count",
    module: "inventory",
    authority: 1,
    description: {
      tr:
        "Stok sayımı açar ve o andaki sistem miktarlarını DONDURUR. Varsayılan " +
        "KÖR SAYIMDIR: sayan kişiye sistemdeki miktar gösterilmez — gösterilseydi " +
        "o sayı kopyalanır ve sayım hiçbir şey bulmazdı. Malzeme listesi " +
        "verilmezse depodaki tüm kalemler alınır.",
      en: "Opens a stock count, freezing system quantities. Blind by default.",
    },
    input: z.strictObject({
      locationId: z.string().min(1).max(64).describe("Sayılacak depo."),
      countDate: z.string().describe("Sayım tarihi (ISO 8601)."),
      blind: z.boolean().describe("Kör sayım mı? Varsayılan davranış: evet."),
      itemCodes: z
        .array(z.string().min(1).max(64))
        .describe("Yalnızca belirli kalemler sayılacaksa kodları. Tümü için boş dizi."),
      note: z.string().max(300).nullable().describe("Açıklama. Yoksa null."),
    }),
    requires: ["inventory:count.write"],
    async execute(input, ctx) {
      const c = await repo.open({
        locationId: input.locationId,
        countDate: new Date(input.countDate),
        userId: ctx.principal.userId,
        blind: input.blind,
        itemCodes: input.itemCodes,
        note: input.note,
      });
      return {
        ok: true as const,
        data: { documentNo: c.documentNo, lineCount: c.lines.length, blind: c.blind },
        sources: [
          {
            system: "Stok sayımı",
            kind: "module" as const,
            recordCount: c.lines.length,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks: [
          {
            severity: "info" as const,
            message:
              `${c.documentNo} açıldı; ${c.lines.length} kalem sayılacak. Sistem ` +
              `miktarları donduruldu, sayım sürerken yapılan hareketler farkı etkilemez.` +
              (c.blind ? " Kör sayım: sayana sistem miktarı gösterilmiyor." : ""),
          },
        ],
        confidence: 97,
      };
    },
  });

  const view = defineTool({
    name: "get_stock_count",
    module: "inventory",
    authority: 0,
    description: {
      tr:
        "Sayım listesini döndürür. KÖR SAYIMDA sistem miktarı gizlidir; yalnızca " +
        "kaydedildikten sonra görünür.",
      en: "Returns the count sheet. System quantities are hidden while blind.",
    },
    input: z.strictObject({
      documentNo: z.string().min(1).max(64).describe("Sayım numarası."),
    }),
    requires: ["inventory:count.read"],
    async execute(input, _ctx) {
      const c = await repo.byNo(input.documentNo);
      return {
        ok: true as const,
        data: c,
        sources: [
          {
            system: "Stok sayımı",
            kind: "module" as const,
            recordCount: c?.lines.length ?? 0,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks: c
          ? []
          : [{ severity: "warning" as const, message: `"${input.documentNo}" sayımı bulunamadı.` }],
        confidence: c ? 96 : 90,
      };
    },
  });

  const record = defineTool({
    name: "record_stock_count",
    module: "inventory",
    authority: 1,
    description: {
      tr:
        "Sayılan miktarları girer. Sayılmayan kalem SIFIR SAYILMAZ; boş kalır ve " +
        "sayım tamamlanmış sayılmaz. Tüm kalemler girildiğinde sayım 'sayıldı' " +
        "durumuna geçer.",
      en: "Records counted quantities. Uncounted lines stay empty, not zero.",
    },
    input: z.strictObject({
      documentNo: z.string().min(1).max(64).describe("Sayım numarası."),
      counts: z
        .array(
          z.strictObject({
            lineNo: z.number().int().positive(),
            countedQty: z.number().nonnegative().describe("Sayılan miktar — temel birimde."),
          }),
        )
        .min(1),
    }),
    requires: ["inventory:count.write"],
    async execute(input, _ctx) {
      const r = await repo.record(input.documentNo, input.counts);
      return {
        ok: true as const,
        data: { documentNo: input.documentNo, ...r },
        sources: [
          {
            system: "Stok sayımı",
            kind: "module" as const,
            recordCount: input.counts.length,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks:
          r.remaining > 0
            ? [
                {
                  severity: "info" as const,
                  message: `${r.remaining} kalem henüz sayılmadı; sayım kaydedilemez.`,
                },
              ]
            : [
                {
                  severity: "info" as const,
                  message: "Tüm kalemler sayıldı; farkları görüp kaydedebilirsiniz.",
                },
              ],
        confidence: 97,
      };
    },
  });

  const differences = defineTool({
    name: "get_stock_count_differences",
    module: "inventory",
    authority: 0,
    description: {
      tr:
        "Sayım farklarını döndürür: hangi kalemde ne kadar fark var, değeri ne, " +
        `ve hangileri TEKRAR SAYIM gerektiriyor (fark %${RECOUNT_THRESHOLD_PERCENT} eşiğini ` +
        "aşanlar). Kaydetmeden önce bakılır.",
      en: "Returns count differences and which lines need a recount.",
    },
    input: z.strictObject({
      documentNo: z.string().min(1).max(64).describe("Sayım numarası."),
    }),
    requires: ["inventory:count.read"],
    async execute(input, _ctx) {
      const r = await repo.differences(input.documentNo);
      const withDiff = r.differences.filter((d) => d.difference !== 0);
      return {
        ok: true as const,
        data: {
          documentNo: r.documentNo,
          status: r.status,
          differences: withDiff,
          summary: r.summary,
        },
        sources: [
          {
            system: "Stok sayımı",
            kind: "module" as const,
            recordCount: withDiff.length,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks: [
          ...(r.summary.recountLines.length > 0
            ? [
                {
                  severity: "critical" as const,
                  message:
                    `${r.summary.recountLines.join(", ")}. kalemlerde fark eşiği aşıyor; ` +
                    `TEKRAR SAYILMALI. Bir yazım hatası kalıcı stok düzeltmesine dönüşmemeli.`,
                },
              ]
            : []),
          ...(r.summary.unvaluedDifferences > 0
            ? [
                {
                  severity: "warning" as const,
                  message:
                    `${r.summary.unvaluedDifferences} farkın maliyeti bilinmiyor; değer ` +
                    `etkisi toplama DAHİL DEĞİL.`,
                },
              ]
            : []),
          ...(withDiff.length > 0
            ? [
                {
                  severity: "warning" as const,
                  message:
                    `${withDiff.length} kalemde fark var; net değer etkisi ` +
                    `${TR.format(r.summary.netValueDifference)} TL.`,
                },
              ]
            : []),
        ],
        confidence: 95,
      };
    },
  });

  const post = defineTool({
    name: "post_stock_count",
    module: "inventory",
    authority: 2,
    description: {
      tr:
        "Sayımı KAYDEDER: stok bakiyelerini sayılan miktara çeker, stok hareketi " +
        "yazar ve fark değerini 689 hesabına muhasebeleştirir. EKSİK SAYIM " +
        "kaydedilemez. Eşiği aşan farklar için `acceptLargeDifferences` açıkça " +
        "verilmelidir. KAYDEDİLEN SAYIM DEĞİŞTİRİLEMEZ.",
      en: "Posts a stock count: adjusts balances, writes movements and a journal entry.",
    },
    input: z.strictObject({
      documentNo: z.string().min(1).max(64).describe("Sayım numarası."),
      acceptLargeDifferences: z
        .boolean()
        .describe("Tekrar sayım eşiğini aşan farklar kabul edilsin mi?"),
    }),
    requires: ["inventory:count.post"],
    async execute(input, ctx) {
      const r = await repo.post({
        documentNo: input.documentNo,
        userId: ctx.principal.userId,
        acceptLargeDifferences: input.acceptLargeDifferences,
      });
      return {
        ok: true as const,
        data: r,
        sources: [
          {
            system: "Stok sayımı",
            kind: "module" as const,
            recordCount: r.adjustedLines,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks: [
          {
            severity: "warning" as const,
            message:
              `${r.documentNo} kaydedildi: ${r.adjustedLines} kalemde düzeltme, net değer ` +
              `etkisi ${TR.format(r.netValueDifference)} TL` +
              (r.journalNo ? ` (fiş ${r.journalNo}).` : ".") +
              " Sayım artık değiştirilemez.",
          },
        ],
        confidence: 97,
      };
    },
  });

  return [open, view, record, differences, post] as const;
}
