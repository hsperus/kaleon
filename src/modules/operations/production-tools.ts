/**
 * Üretim ve stok tool'ları.
 *
 * Bu dosya alan mantığına yeni kural EKLEMEZ; onu tool sözleşmesine bağlar.
 * Bütün kurallar `work-order.ts` ve `stock-ledger.ts` içindedir ve repository
 * tarafından kilit altında uygulanır. Bir kuralı burada tekrar yazmak,
 * iki yerde ayrışacak iki gerçek üretmek olurdu.
 *
 * `BusinessRuleError` bilinçli olarak yakalanmaz: invoker onu `userFacing`
 * hata olarak modele iletir, model de kullanıcıya GERÇEK nedeni söyler
 * ("kalite kapısı geçilmeden sonraki operasyona aktarım yapılamaz").
 * Genel bir "işlem başarısız" mesajı, ürünün en değerli davranışını öldürürdü.
 */

import { z } from "zod";
import { BusinessRuleError } from "../../kernel/errors.js";
import { defineTool } from "../../kernel/tool.js";
import type { SourceRef, ToolOk } from "../../kernel/types.js";
import type { OperationsRepository } from "./repository.js";
import { MOVEMENT_TYPES, type StockMovement } from "./stock-ledger.js";
import {
  confirmOperation,
  nextAction,
  overrideGate,
  recordGateDecision,
  releaseWorkOrder,
  startOperation,
  type WorkOrder,
} from "./work-order.js";

/** KAELON üretim verisinin System of Record'udur — kaynak kendisidir. */
function sourceNow(now: Date, recordCount: number, system = "Operations Core"): SourceRef[] {
  return [{ system, kind: "module", recordCount, syncedAt: now.toISOString() }];
}

function summarize(wo: WorkOrder) {
  return {
    id: wo.id,
    itemId: wo.itemId,
    quantity: wo.quantity,
    status: wo.status,
    bomRevision: wo.bomRevision,
    overrideCount: wo.overrideCount,
    nextAction: nextAction(wo),
    operations: wo.operations.map((o) => ({
      seq: o.seq,
      workCenter: o.workCenter,
      description: o.description,
      state: o.state,
      confirmedQty: o.confirmedQty,
      scrapQty: o.scrapQty,
      gate: o.gate ? o.gate.characteristic : null,
      gateOverridden: o.gateDecision?.overridden ?? false,
    })),
  };
}

export function productionTools(repo: OperationsRepository) {
  // ─────────────────────── L0 · okuma ───────────────────────

  const getWorkOrder = defineTool({
    name: "get_work_order",
    module: "operations",
    authority: 0,
    deferLoading: false,
    description: {
      tr: "Bir iş emrinin tam durumunu döndürür: operasyonlar, kalite kapısı durumları, teyit ve fire miktarları, dondurulmuş BOM revizyonu ve yapılabilecek bir sonraki adım. 'WO-... ne durumda', 'iş emri neden ilerlemiyor' sorularında kullan.",
      en: "Full work order status: operations, quality gate states, confirmed/scrap quantities, frozen BOM revision and the next possible action.",
    },
    input: z.strictObject({
      workOrderId: z.string().min(3).describe("İş emri numarası, örn. WO-2026-0612"),
    }),
    requires: ["operations:workorder.read"],
    async execute(input, ctx) {
      const wo = await repo.getWorkOrder(ctx.tenant.tenantId, input.workOrderId);
      if (!wo) {
        return {
          ok: true as const,
          data: null,
          sources: sourceNow(ctx.now(), 0),
          risks: [
            {
              severity: "info" as const,
              message: `${input.workOrderId} numaralı iş emri yok. Numarayı doğrula; uydurma bilgi verme.`,
            },
          ],
        };
      }
      const blocked = wo.operations.some((o) => o.state === "gate_hold" || o.state === "gate_failed");
      return {
        ok: true as const,
        data: summarize(wo),
        sources: sourceNow(ctx.now(), wo.operations.length),
        risks: blocked
          ? [{ severity: "warning" as const, message: nextAction(wo) }]
          : [],
        confidence: 100,
      };
    },
  });

  const listWorkOrders = defineTool({
    name: "list_work_orders",
    module: "operations",
    authority: 0,
    description: {
      tr: "İş emirlerini duruma veya iş merkezine göre listeler. 'Kaç açık iş emri var', 'boyada ne bekliyor', 'kalite hold'da neler var' sorularında kullan.",
      en: "Lists work orders filtered by status or work center.",
    },
    input: z.strictObject({
      status: z
        .enum(["created", "released", "in_progress", "completed", "technically_closed"])
        .nullable()
        .describe("Duruma göre filtre. Tümü için null."),
      workCenter: z.string().min(2).nullable().describe("İş merkezi adı. Tümü için null."),
    }),
    requires: ["operations:workorder.read"],
    async execute(input, ctx) {
      const rows = await repo.listWorkOrders(ctx.tenant.tenantId, {
        ...(input.status ? { status: input.status } : {}),
        ...(input.workCenter ? { workCenter: input.workCenter } : {}),
      });
      const held = rows.filter((wo) => wo.operations.some((o) => o.state === "gate_hold"));
      return {
        ok: true as const,
        data: rows.map(summarize),
        sources: sourceNow(ctx.now(), rows.length),
        risks: held.length
          ? [
              {
                severity: "warning" as const,
                message: `${held.length} iş emri kalite kararı bekliyor: ${held.map((w) => w.id).join(", ")}`,
              },
            ]
          : [],
        confidence: 100,
      };
    },
  });

  const getStockBalance = defineTool({
    name: "get_stock_balance",
    module: "inventory",
    authority: 0,
    deferLoading: false,
    description: {
      tr: "Bir kalemin belirli lokasyon ve partideki stok bakiyesini döndürür. Bakiye saklanmaz, hareketlerden türetilir — dolayısıyla her zaman defterle tutarlıdır. 'Stokta kaç adet var', 'depoda ne kadar kaldı' sorularında kullan.",
      en: "Stock balance for an item at a location/batch. Derived from the movement ledger, never stored.",
    },
    input: z.strictObject({
      itemId: z.string().min(1).describe("Malzeme kodu"),
      locationId: z.string().min(1).describe("Depo/lokasyon kodu"),
      batchId: z.string().min(1).nullable().describe("Parti numarası; partisiz için null."),
    }),
    requires: ["inventory:stock.read"],
    async execute(input, ctx) {
      const key = { itemId: input.itemId, locationId: input.locationId, batchId: input.batchId };
      const quantity = await repo.balance(ctx.tenant.tenantId, key);
      const movements = await repo.movements(ctx.tenant.tenantId, key);
      return {
        ok: true as const,
        data: { ...key, quantity, movementCount: movements.length },
        sources: sourceNow(ctx.now(), movements.length, "Stok defteri"),
        confidence: 100,
      };
    },
  });

  const listStockMovements = defineTool({
    name: "list_stock_movements",
    module: "inventory",
    authority: 0,
    description: {
      tr: "Bir kalemin stok hareket defterini döndürür: hareket tipi, miktar, belge referansı, kullanıcı ve gerekçe. Bakiyedeki bir farkın nereden geldiğini açıklamak için kullan. Hareketler silinmez; iptaller ters hareket olarak görünür.",
      en: "Stock movement ledger for an item: type, quantity, document reference, user and reason. Reversals appear as counter-movements; nothing is deleted.",
    },
    input: z.strictObject({
      itemId: z.string().min(1),
      locationId: z.string().min(1).nullable().describe("Lokasyon filtresi; tümü için null."),
    }),
    requires: ["inventory:stock.read"],
    async execute(input, ctx) {
      const movements = await repo.movements(ctx.tenant.tenantId, {
        itemId: input.itemId,
        ...(input.locationId ? { locationId: input.locationId } : {}),
      });
      const reversed = movements.filter((m) => m.reversalOf !== null).length;
      return {
        ok: true as const,
        data: movements.map((m: StockMovement) => ({
          ...m,
          typeLabel: MOVEMENT_TYPES[m.movementType]?.label ?? m.movementType,
        })),
        sources: sourceNow(ctx.now(), movements.length, "Stok defteri"),
        risks: reversed
          ? [{ severity: "info" as const, message: `${reversed} hareket iptal edilmiş; bakiyeye etkileri defterde görünür.` }]
          : [],
        confidence: 100,
      };
    },
  });

  // ─────────────────────── L1 · yazma ───────────────────────

  const releaseWorkOrderTool = defineTool({
    name: "release_work_order",
    module: "operations",
    authority: 1,
    description: {
      tr: "İş emrini serbest bırakır ve BOM revizyonunu DONDURUR. Bu andan sonra yayınlanan yeni revizyon bu iş emrini etkilemez. Aktif olmayan bir revizyon istenirse L2 yetki ve gerekçe gerekir.",
      en: "Releases a work order and freezes its BOM revision. Using a non-active revision requires L2 authority and a reason.",
    },
    input: z.strictObject({
      workOrderId: z.string().min(3),
      requestedRevision: z
        .string()
        .min(1)
        .nullable()
        .describe("Belirli bir BOM revizyonu isteniyorsa; aktif revizyon için null."),
      reason: z.string().min(5).nullable().describe("Aktif olmayan revizyon kullanılıyorsa gerekçe."),
    }),
    requires: ["operations:workorder.write"],
    async execute(input, ctx) {
      const existing = await repo.getWorkOrder(ctx.tenant.tenantId, input.workOrderId);
      // KULLANICIYA GÖRÜNÜR HATA. Düz `Error` ekranda "Tool
      // çalıştırılamadı" olarak çıkar ve kişi yanlış numara mı yazdığını
      // yoksa sistemin mi bozuk olduğunu anlayamaz.
      if (!existing) {
        throw new BusinessRuleError(
          `İş emri bulunamadı: ${input.workOrderId}`,
          "work_order_missing",
        );
      }
      const activeBomRevision = await repo.activeBomRevision(ctx.tenant.tenantId, existing.itemId);

      const wo = await repo.mutateWorkOrder(ctx.tenant.tenantId, input.workOrderId, (current) =>
        releaseWorkOrder(current, {
          activeBomRevision,
          ...(input.requestedRevision ? { requestedRevision: input.requestedRevision } : {}),
          at: ctx.now().toISOString(),
          principal: ctx.principal,
          ...(input.reason ? { reason: input.reason } : {}),
        }),
      );

      return {
        ok: true as const,
        data: summarize(wo),
        sources: sourceNow(ctx.now(), 1),
        risks:
          wo.bomRevision !== activeBomRevision
            ? [
                {
                  severity: "warning" as const,
                  message: `Aktif olmayan BOM revizyonu (${wo.bomRevision}) donduruldu; aktif ${activeBomRevision}.`,
                },
              ]
            : [],
        confidence: 100,
      };
    },
  });

  const startOperationTool = defineTool({
    name: "start_operation",
    module: "operations",
    authority: 1,
    description: {
      tr: "Bir operasyonu başlatır. Önceki operasyonun kalite kapısı geçmemişse BAŞLATMAZ ve nedenini söyler — bu kural sistem seviyesinde uygulanır, atlanamaz.",
      en: "Starts an operation. Refuses if the previous operation's quality gate has not passed.",
    },
    input: z.strictObject({
      workOrderId: z.string().min(3),
      seq: z.number().int().positive().describe("Operasyon sıra numarası, örn. 20"),
    }),
    requires: ["operations:workorder.own"],
    async execute(input, ctx) {
      const wo = await repo.mutateWorkOrder(ctx.tenant.tenantId, input.workOrderId, (current) =>
        startOperation(current, input.seq),
      );
      return { ok: true as const, data: summarize(wo), sources: sourceNow(ctx.now(), 1), confidence: 100 };
    },
  });

  const confirmOperationTool = defineTool({
    name: "confirm_operation",
    module: "operations",
    authority: 1,
    description: {
      tr: "Operasyonu teyit eder: üretilen miktar ve fire. Operasyonun kalite kapısı varsa doğrudan geçmez, kalite kararı beklemeye alınır.",
      en: "Confirms an operation with produced and scrap quantities. If the operation has a quality gate, it moves to gate_hold rather than completing.",
    },
    input: z.strictObject({
      workOrderId: z.string().min(3),
      seq: z.number().int().positive(),
      confirmedQty: z.number().nonnegative().describe("Sağlam üretilen miktar"),
      scrapQty: z.number().nonnegative().describe("Fire miktarı; yoksa 0"),
    }),
    requires: ["operations:workorder.own"],
    async execute(input, ctx) {
      const wo = await repo.mutateWorkOrder(ctx.tenant.tenantId, input.workOrderId, (current) =>
        confirmOperation(current, input.seq, {
          confirmedQty: input.confirmedQty,
          scrapQty: input.scrapQty,
        }),
      );
      const op = wo.operations.find((o) => o.seq === input.seq);
      return {
        ok: true as const,
        data: summarize(wo),
        sources: sourceNow(ctx.now(), 1),
        risks:
          op?.state === "gate_hold"
            ? [
                {
                  severity: "warning" as const,
                  message: `Operasyon ${input.seq} kalite kararı bekliyor ("${op.gate?.characteristic}"). Karar verilmeden sonraki operasyon başlatılamaz.`,
                },
              ]
            : [],
        confidence: 100,
      };
    },
  });

  const postStockMovement = defineTool({
    name: "post_stock_movement",
    module: "inventory",
    authority: 1,
    description: {
      tr: "Stok hareketi kaydeder. Hareket tipi zorunludur ve yönü belirler: 101 satın alma mal kabulü, 261 iş emrine sarf, 131 üretimden mamul girişi, 551 fire, 601 sevkiyat, 311/312 depolar arası transfer, 541 fasona gönderim. Her hareket bir belgeye bağlanmak zorundadır. Negatif stok oluşturacak hareket reddedilir.",
      en: "Posts a stock movement. Movement type determines direction and required document. Movements that would drive stock negative are rejected.",
    },
    input: z.strictObject({
      movementType: z
        .enum(["101", "261", "131", "551", "601", "311", "312", "541"])
        .describe("Hareket tipi"),
      itemId: z.string().min(1),
      locationId: z.string().min(1),
      batchId: z.string().min(1).nullable(),
      quantity: z.number().positive().describe("Her zaman pozitif; yön hareket tipinden gelir."),
      referenceKind: z
        .enum(["purchase_order", "work_order", "delivery", "transfer"])
        .describe("Bağlanacak belge tipi"),
      referenceId: z.string().min(1).describe("Belge numarası"),
      reason: z.string().min(3).nullable().describe("Fire gibi gerekçe isteyen tiplerde zorunlu."),
    }),
    requires: ["inventory:movement.write"],
    async execute(input, ctx) {
      const movement = await repo.postMovement(
        ctx.tenant.tenantId,
        {
          id: "",
          at: ctx.now().toISOString(),
          itemId: input.itemId,
          locationId: input.locationId,
          batchId: input.batchId,
          quantity: input.quantity,
          movementType: input.movementType,
          reference: { kind: input.referenceKind, id: input.referenceId },
          userId: ctx.principal.userId,
          reason: input.reason,
        },
        { authority: ctx.principal.maxAuthority },
      );
      const balance = await repo.balance(ctx.tenant.tenantId, {
        itemId: input.itemId,
        locationId: input.locationId,
        batchId: input.batchId,
      });
      return {
        ok: true as const,
        data: { movement, newBalance: balance },
        sources: sourceNow(ctx.now(), 1, "Stok defteri"),
        confidence: 100,
      };
    },
  });

  // ─────────────────────── L2 · onay/kritik ───────────────────────

  const recordQualityDecision = defineTool({
    name: "record_quality_decision",
    module: "quality",
    authority: 2,
    description: {
      tr: "Kalite kapısı kararı kaydeder (PASS/FAIL). Yalnızca kalite serbest bırakma iznine sahip kullanıcı verebilir. Tolerans tanımlıysa ölçüm zorunludur ve tolerans dışı değerle PASS verilemez. FAIL için neden zorunludur.",
      en: "Records a quality gate decision. Requires gate-release permission; out-of-tolerance PASS is rejected; FAIL requires a reason.",
    },
    input: z.strictObject({
      workOrderId: z.string().min(3),
      seq: z.number().int().positive(),
      decision: z.enum(["pass", "fail"]),
      measurement: z.number().nullable().describe("Toleranslı kapılarda ölçüm değeri; yoksa null."),
      reason: z.string().min(5).nullable().describe("FAIL kararında zorunlu."),
    }),
    requires: ["quality:gate.release"],
    async execute(input, ctx) {
      const wo = await repo.mutateWorkOrder(ctx.tenant.tenantId, input.workOrderId, (current) =>
        recordGateDecision(current, input.seq, {
          decision: input.decision,
          principal: ctx.principal,
          at: ctx.now().toISOString(),
          ...(input.measurement !== null ? { measurement: input.measurement } : {}),
          ...(input.reason ? { reason: input.reason } : {}),
        }),
      );
      return {
        ok: true as const,
        data: summarize(wo),
        sources: sourceNow(ctx.now(), 1, "Kalite kayıtları"),
        risks:
          input.decision === "fail"
            ? [{ severity: "critical" as const, message: `Operasyon ${input.seq} kalite kapısından geçemedi; sonraki operasyon kapalı.` }]
            : [],
        confidence: 100,
      };
    },
  });

  const overrideQualityGate = defineTool({
    name: "override_quality_gate",
    module: "quality",
    authority: 2,
    description: {
      tr: "Kalite kapısını gerekçeyle atlar. YASAK DEĞİL ama KALICI İZ BIRAKIR: iş emrinde override işareti, audit kaydı ve Boss Mode regülasyon skoruna etki. Ancak istisnai durumlarda kullanılmalı; kullanıcıya sonucunu açıkça söyle.",
      en: "Overrides a quality gate with a mandatory reason. Permitted but permanently recorded and counted in the regulation health score.",
    },
    input: z.strictObject({
      workOrderId: z.string().min(3),
      seq: z.number().int().positive(),
      reason: z.string().min(15).describe("Detaylı gerekçe — kim, neden, hangi onayla."),
    }),
    requires: ["quality:gate.override"],
    async execute(input, ctx) {
      const wo = await repo.mutateWorkOrder(ctx.tenant.tenantId, input.workOrderId, (current) =>
        overrideGate(current, input.seq, {
          principal: ctx.principal,
          at: ctx.now().toISOString(),
          reason: input.reason,
        }),
      );
      return {
        ok: true as const,
        data: summarize(wo),
        sources: sourceNow(ctx.now(), 1, "Kalite kayıtları"),
        risks: [
          {
            severity: "warning" as const,
            message: `Kalite kapısı atlandı. Bu iş emrinde toplam ${wo.overrideCount} override var ve regülasyon sağlık skoruna yansır.`,
          },
        ],
        confidence: 100,
      };
    },
  });

  const postStockCorrection = defineTool({
    name: "post_stock_correction",
    module: "inventory",
    authority: 2,
    description: {
      tr: "Sayım farkı kaydeder (701 fazla, 702 eksik). Gerekçe ZORUNLUDUR. Stok bakiyesi doğrudan düzeltilemez — düzeltme de gerekçeli bir harekettir ve defterde görünür.",
      en: "Posts an inventory count difference (701 surplus, 702 shortage). Reason mandatory; balances are never edited directly.",
    },
    input: z.strictObject({
      direction: z.enum(["701", "702"]).describe("701 sayım fazlası, 702 sayım eksiği"),
      itemId: z.string().min(1),
      locationId: z.string().min(1),
      batchId: z.string().min(1).nullable(),
      quantity: z.number().positive(),
      countId: z.string().min(1).describe("Sayım belgesi numarası"),
      reason: z.string().min(10).describe("Farkın nedeni — zorunlu."),
    }),
    requires: ["inventory:adjustment.write"],
    async execute(input, ctx) {
      const movement = await repo.postMovement(
        ctx.tenant.tenantId,
        {
          id: "",
          at: ctx.now().toISOString(),
          itemId: input.itemId,
          locationId: input.locationId,
          batchId: input.batchId,
          quantity: input.quantity,
          movementType: input.direction,
          reference: { kind: "count", id: input.countId },
          userId: ctx.principal.userId,
          reason: input.reason,
        },
        { authority: ctx.principal.maxAuthority },
      );
      return {
        ok: true as const,
        data: movement,
        sources: sourceNow(ctx.now(), 1, "Stok defteri"),
        risks: [
          {
            severity: "warning" as const,
            message: "Sayım farkı kaydedildi; stok doğruluk skorunu etkiler ve Boss Mode'da görünür.",
          },
        ],
        confidence: 100,
      };
    },
  });

  const reverseStockMovement = defineTool({
    name: "reverse_stock_movement",
    module: "inventory",
    authority: 2,
    description: {
      tr: "Bir stok hareketini iptal eder. İptal SİLME DEĞİLDİR: aslına referans veren ters yönlü yeni bir hareket yazılır, asıl hareket defterde kalır. Aynı hareket iki kez iptal edilemez.",
      en: "Reverses a stock movement by posting a counter-movement. Nothing is deleted; double reversal is rejected.",
    },
    input: z.strictObject({
      originalMovementId: z.string().min(1),
      reversalType: z.enum(["102", "262", "132", "602"]).describe("İptal tipi — asıl hareketin tipine uymalı"),
      quantity: z.number().positive().describe("İptal miktarı; aslından büyük olamaz."),
      reason: z.string().min(10).describe("İptal gerekçesi — zorunlu."),
    }),
    requires: ["inventory:adjustment.write"],
    async execute(input, ctx): Promise<ToolOk<unknown>> {
      const all = await repo.movements(ctx.tenant.tenantId, {});
      const original = all.find((m) => m.id === input.originalMovementId);
      if (!original) {
        throw new BusinessRuleError(
          `Hareket bulunamadı: ${input.originalMovementId}`,
          "movement_missing",
        );
      }

      const movement = await repo.postMovement(
        ctx.tenant.tenantId,
        {
          id: "",
          at: ctx.now().toISOString(),
          itemId: original.itemId,
          locationId: original.locationId,
          batchId: original.batchId,
          quantity: input.quantity,
          movementType: input.reversalType,
          reference: original.reference,
          userId: ctx.principal.userId,
          reason: input.reason,
          reversalOf: original.id,
        },
        { authority: ctx.principal.maxAuthority },
      );
      return {
        ok: true as const,
        data: { reversal: movement, original },
        sources: sourceNow(ctx.now(), 2, "Stok defteri"),
        confidence: 100,
      };
    },
  });

  return [
    getWorkOrder,
    listWorkOrders,
    getStockBalance,
    listStockMovements,
    releaseWorkOrderTool,
    startOperationTool,
    confirmOperationTool,
    postStockMovement,
    recordQualityDecision,
    overrideQualityGate,
    postStockCorrection,
    reverseStockMovement,
  ] as const;
}
