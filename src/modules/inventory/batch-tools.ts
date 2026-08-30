/**
 * Parti izleme tool'ları.
 *
 * GERİ ÇAĞIRMA SORULARI L0'DIR. Bir parti şüpheliyse "kime gitti"
 * sorusunun cevabı dakikalar içinde gerekir; onay beklemek, cevabın
 * kendisini işe yaramaz hâle getirir. Partiyi BLOKE ETMEK ise yazma
 * işlemidir ve L2'dir — sevkiyatı durdurur.
 *
 * BOŞ CEVAP "TEMİZ" DEMEK DEĞİLDİR. Bir izleme sorgusu hiçbir şey
 * bulamadıysa iki ihtimal vardır: parti hiçbir yere gitmemiştir, ya da
 * bağlar hiç yazılmamıştır. İkisi çok farklı şeylerdir ve fark
 * söylenmeden verilen "temiz" cevabı, geri çağırmayı eksik yapar.
 */

import { z } from "zod";
import { defineTool } from "../../kernel/tool.js";
import type { BatchRepository } from "../../db/batch-repository.js";
import { BATCH_STATUSES, EXPIRY_WARNING_DAYS } from "./batch.js";

export function batchTools(repo: BatchRepository) {
  const getBatch = defineTool({
    name: "get_batch",
    module: "inventory",
    authority: 0,
    description: {
      tr:
        "Bir partinin kartını döndürür: durumu (serbest/karantina/bloke), üretim " +
        "veya giriş tarihi, son kullanma tarihi ve tedarikçinin kendi parti numarası.",
      en: "Returns a batch record with status, dates and supplier batch number.",
    },
    input: z.strictObject({
      itemCode: z.string().min(1).max(64).describe("Malzeme kodu."),
      batchNo: z.string().min(1).max(64).describe("Parti numarası."),
    }),
    requires: ["inventory:batch.read"],
    async execute(input, _ctx) {
      const b = await repo.byNo(input.itemCode, input.batchNo);
      return {
        ok: true as const,
        data: b,
        sources: [
          {
            system: "Parti izleme",
            kind: "module" as const,
            recordCount: b ? 1 : 0,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks: b
          ? b.status !== "available"
            ? [
                {
                  severity: "warning" as const,
                  message: `"${b.batchNo}" partisi ${b.status === "blocked" ? "BLOKELİ" : b.status === "quarantine" ? "KARANTİNADA" : "tüketilmiş"}.`,
                },
              ]
            : []
          : [
              {
                severity: "warning" as const,
                message: `"${input.itemCode}" için "${input.batchNo}" partisi sistemde yok.`,
              },
            ],
        confidence: b ? 96 : 90,
      };
    },
  });

  const traceForward = defineTool({
    name: "trace_batch_forward",
    module: "inventory",
    authority: 0,
    description: {
      tr:
        "İLERİ İZLEME: bu parti nereye gitti? Bu partiden üretilen alt partileri " +
        "ve partinin gittiği müşterileri/irsaliyeleri döndürür. Geri çağırmanın " +
        "KAPSAMINI belirler. 'Bu partiden kime gönderdik' sorusunda kullan.",
      en: "Forward trace: which batches and customers received this batch.",
    },
    input: z.strictObject({
      itemCode: z.string().min(1).max(64).describe("Malzeme kodu."),
      batchNo: z.string().min(1).max(64).describe("Parti numarası."),
    }),
    requires: ["inventory:batch.read"],
    async execute(input, _ctx) {
      const t = await repo.traceForward(input.itemCode, input.batchNo);
      const customers = [...new Set(t.shipments.map((s) => s.customer))];
      return {
        ok: true as const,
        data: {
          batchNo: t.root,
          derivedBatches: t.derivedBatches,
          shipments: t.shipments,
          affectedCustomers: customers,
        },
        sources: [
          {
            system: "Parti şeceresi",
            kind: "module" as const,
            recordCount: t.derivedBatches.length + t.shipments.length,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks: [
          ...t.caveats.map((c) => ({ severity: "warning" as const, message: c })),
          ...(customers.length > 0
            ? [
                {
                  severity: "critical" as const,
                  message:
                    `Bu parti ${customers.length} müşteriye ulaşmış: ${customers.join(", ")}. ` +
                    `Geri çağırma kapsamı bu listedir.`,
                },
              ]
            : []),
        ],
        confidence: t.caveats.length > 0 ? 65 : 94,
      };
    },
  });

  const traceBackward = defineTool({
    name: "trace_batch_backward",
    module: "inventory",
    authority: 0,
    description: {
      tr:
        "GERİ İZLEME: bu parti neyden yapıldı? Kaynak partileri ve zincirin " +
        "ucundaki tedarikçi partilerini döndürür. Hatanın KAYNAĞINI belirler. " +
        "'Bu üründe kimin hammaddesi var' sorusunda kullan.",
      en: "Backward trace: which source batches and suppliers this batch came from.",
    },
    input: z.strictObject({
      itemCode: z.string().min(1).max(64).describe("Malzeme kodu."),
      batchNo: z.string().min(1).max(64).describe("Parti numarası."),
    }),
    requires: ["inventory:batch.read"],
    async execute(input, _ctx) {
      const t = await repo.traceBackward(input.itemCode, input.batchNo);
      const suppliers = [...new Set(t.receipts.map((r) => r.supplier).filter(Boolean))];
      return {
        ok: true as const,
        data: {
          batchNo: t.root,
          sourceBatches: t.sourceBatches,
          supplierBatches: t.receipts,
          suppliers,
        },
        sources: [
          {
            system: "Parti şeceresi",
            kind: "module" as const,
            recordCount: t.sourceBatches.length,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks: t.caveats.map((c) => ({ severity: "warning" as const, message: c })),
        confidence: t.caveats.length > 0 ? 65 : 94,
      };
    },
  });

  const setStatus = defineTool({
    name: "set_batch_status",
    module: "inventory",
    authority: 2,
    description: {
      tr:
        "Partinin durumunu değiştirir: serbest, karantina veya bloke. BLOKE ETMEK " +
        "GERİ ÇAĞIRMANIN İLK ADIMIDIR — şüpheli parti önce durdurulur, sonra " +
        "nereye gittiği araştırılır. Bloke parti sevk edilemez.",
      en: "Changes batch status (available/quarantine/blocked). Blocked batches cannot ship.",
    },
    input: z.strictObject({
      itemCode: z.string().min(1).max(64).describe("Malzeme kodu."),
      batchNo: z.string().min(1).max(64).describe("Parti numarası."),
      status: z.enum(BATCH_STATUSES).describe("Yeni durum."),
      reason: z.string().min(3).max(300).describe("Sebep — kayda geçer."),
    }),
    requires: ["inventory:batch.write"],
    async execute(input, _ctx) {
      const b = await repo.setStatus(input.itemCode, input.batchNo, input.status);
      return {
        ok: true as const,
        data: { itemCode: b.itemCode, batchNo: b.batchNo, status: b.status },
        sources: [
          {
            system: "Parti izleme",
            kind: "module" as const,
            recordCount: 1,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks: [
          {
            severity: input.status === "blocked" ? ("critical" as const) : ("warning" as const),
            message:
              `"${b.batchNo}" partisi ${input.status} durumuna alındı (${input.reason}).` +
              (input.status === "blocked"
                ? " Bu parti artık sevk EDİLEMEZ. Nereye gittiğini görmek için ileri izleme yapın."
                : ""),
          },
        ],
        confidence: 98,
      };
    },
  });

  const expiring = defineTool({
    name: "list_expiring_batches",
    module: "inventory",
    authority: 0,
    description: {
      tr:
        `Son kullanma tarihi yaklaşan partileri listeler (varsayılan ${EXPIRY_WARNING_DAYS} gün). ` +
        "Tükenmiş partiler listelenmez. En acili başta olmak üzere sıralanır.",
      en: "Lists batches approaching their expiry date.",
    },
    input: z.strictObject({
      withinDays: z
        .number()
        .int()
        .positive()
        .max(365)
        .describe(`Kaç gün içinde dolacaklar listelensin. Tipik değer ${EXPIRY_WARNING_DAYS}.`),
    }),
    requires: ["inventory:batch.read"],
    async execute(input, ctx) {
      const rows = await repo.expiring(ctx.now(), input.withinDays);
      const expired = rows.filter((r) => r.daysLeft < 0);
      return {
        ok: true as const,
        data: { withinDays: input.withinDays, batches: rows },
        sources: [
          {
            system: "Parti izleme",
            kind: "module" as const,
            recordCount: rows.length,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks:
          expired.length > 0
            ? [
                {
                  severity: "critical" as const,
                  message:
                    `${expired.length} partinin son kullanma tarihi GEÇMİŞ ve stokta ` +
                    `görünüyor: ${expired.map((e) => e.batchNo).join(", ")}. Bunlar sevk edilemez.`,
                },
              ]
            : [],
        confidence: 95,
      };
    },
  });

  return [getBatch, traceForward, traceBackward, setStatus, expiring] as const;
}
