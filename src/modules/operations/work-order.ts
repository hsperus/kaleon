/**
 * Process-gated iş emri — KAELON'un üretim hakimiyetinin çekirdeği.
 *
 * Ürün Mantığı §13: "Kalite kapısı geçmeyen iş emri bir sonraki operasyona
 * aktarılamaz — bu kural SİSTEM seviyesinde uygulanır, kullanıcı seviyesinde
 * değil. Operatör 'atlayalım, sonra hallederiz' diyemez."
 *
 * Klasik ERP'lerde bu kural vardır ama bypass edilebilir: sıradaki operasyonu
 * elle açarsınız, kalite kaydını sonra girersiniz, ay sonunda kimse fark etmez.
 * Burada bypass yolu YOKTUR — bir sonraki operasyonu başlatan fonksiyon,
 * öncekinin kapısını kontrol etmeden dönmez.
 *
 * Override tamamen yasak değildir (gerçek fabrikada istisna olur) ama:
 *   - L2 yetki ister,
 *   - gerekçe zorunludur,
 *   - iş emrinde kalıcı iz bırakır ve Boss Mode'da sayılır.
 * Yani mümkün ama görünür. Klasik ERP'de mümkün ve görünmez.
 */

import type { AuthorityLevel, Permission, Principal } from "../../kernel/types.js";
import { BusinessRuleError } from "../../kernel/errors.js";
import { holds } from "../../kernel/rbac.js";

export interface QualityGate {
  /** Neyin kontrol edildiği — "kaynak penetrasyonu", "boya kalınlığı". */
  readonly characteristic: string;
  /** Kararı verebilecek izin. Bu izne sahip olmayan PASS veremez. */
  readonly decidedBy: Permission;
  /** Sayısal kontrol varsa tolerans aralığı. */
  readonly tolerance?: { readonly min: number; readonly max: number; readonly unit: string };
}

export interface RoutingOperation {
  readonly seq: number;
  readonly workCenter: string;
  readonly description: string;
  readonly gate: QualityGate | null;
}

export type OperationState =
  | "pending"
  | "running"
  | "confirmed"
  | "gate_hold"
  | "gate_passed"
  | "gate_failed";

export interface GateDecision {
  readonly decision: "pass" | "fail";
  readonly by: string;
  readonly at: string;
  readonly measurement: number | null;
  readonly reason: string | null;
  /** Kapı atlanarak mı geçildi? Boss Mode bunu sayar. */
  readonly overridden: boolean;
}

export interface WorkOrderOperation extends RoutingOperation {
  readonly state: OperationState;
  readonly confirmedQty: number;
  readonly scrapQty: number;
  readonly gateDecision: GateDecision | null;
}

export type WorkOrderStatus =
  | "created"
  | "released"
  | "in_progress"
  | "completed"
  | "technically_closed";

export interface WorkOrder {
  readonly id: string;
  readonly itemId: string;
  readonly quantity: number;
  readonly status: WorkOrderStatus;
  /**
   * İş emri AÇILIRKEN dondurulan BOM revizyonu.
   * Sonradan yayınlanan revizyon bu iş emrini etkilemez — üretim ortasında
   * reçete değişmesi, klasik ERP'lerin en pahalı hatalarından biridir.
   */
  readonly bomRevision: string | null;
  readonly bomFrozenAt: string | null;
  readonly operations: readonly WorkOrderOperation[];
  /** Kapı atlama sayısı — regülasyon sağlık skorunun girdisi. */
  readonly overrideCount: number;
}

export function createWorkOrder(input: {
  id: string;
  itemId: string;
  quantity: number;
  routing: readonly RoutingOperation[];
}): WorkOrder {
  if (input.quantity <= 0) {
    throw new BusinessRuleError("İş emri miktarı pozitif olmalıdır.", "quantity_must_be_positive");
  }
  if (input.routing.length === 0) {
    throw new BusinessRuleError("Rotasız iş emri açılamaz.", "routing_required");
  }
  const seqs = input.routing.map((o) => o.seq);
  if (new Set(seqs).size !== seqs.length) {
    throw new BusinessRuleError("Operasyon sıra numaraları benzersiz olmalıdır.", "duplicate_sequence");
  }

  return {
    id: input.id,
    itemId: input.itemId,
    quantity: input.quantity,
    status: "created",
    bomRevision: null,
    bomFrozenAt: null,
    overrideCount: 0,
    operations: [...input.routing]
      .sort((a, b) => a.seq - b.seq)
      .map((op) => ({
        ...op,
        state: "pending" as const,
        confirmedQty: 0,
        scrapQty: 0,
        gateDecision: null,
      })),
  };
}

/**
 * İş emrini serbest bırakır ve BOM revizyonunu dondurur.
 *
 * Aktif olmayan bir revizyonla açmak mümkündür — ama L2 yetki ve gerekçe ister.
 * Klasik ERP'de bu sessizce olur ve malzeme harcandıktan sonra fark edilir.
 */
export function releaseWorkOrder(
  wo: WorkOrder,
  input: {
    activeBomRevision: string;
    requestedRevision?: string;
    at: string;
    principal: Principal;
    reason?: string;
  },
): WorkOrder {
  if (wo.status !== "created") {
    throw new BusinessRuleError(
      `İş emri "${wo.status}" durumunda; yalnızca "created" serbest bırakılabilir.`,
      "invalid_transition",
    );
  }

  const revision = input.requestedRevision ?? input.activeBomRevision;

  if (revision !== input.activeBomRevision) {
    if (input.principal.maxAuthority < 2) {
      throw new BusinessRuleError(
        `Eski BOM revizyonu (${revision}) ile iş emri açmak L2 yetki gerektirir. ` +
          `Aktif revizyon: ${input.activeBomRevision}.`,
        "old_revision_requires_authority",
      );
    }
    if (!input.reason?.trim()) {
      throw new BusinessRuleError(
        "Aktif olmayan BOM revizyonu kullanmak için gerekçe zorunludur.",
        "reason_required",
      );
    }
  }

  return { ...wo, status: "released", bomRevision: revision, bomFrozenAt: input.at };
}

function requireOperation(wo: WorkOrder, seq: number): WorkOrderOperation {
  const op = wo.operations.find((o) => o.seq === seq);
  if (!op) throw new BusinessRuleError(`Operasyon ${seq} bulunamadı.`, "operation_not_found");
  return op;
}

/** Bir operasyon "tamamlanmış ve geçilebilir" mi? */
function isCleared(op: WorkOrderOperation): boolean {
  return op.gate ? op.state === "gate_passed" : op.state === "confirmed";
}

function replaceOperation(
  wo: WorkOrder,
  seq: number,
  patch: Partial<WorkOrderOperation>,
  extra?: Partial<WorkOrder>,
): WorkOrder {
  return {
    ...wo,
    ...extra,
    operations: wo.operations.map((o) => (o.seq === seq ? { ...o, ...patch } : o)),
  };
}

/**
 * Operasyonu başlatır.
 *
 * BURASI ÜRÜNÜN EN KRİTİK DEĞİŞMEZİDİR: önceki operasyonun kalite kapısı
 * geçmeden bu fonksiyon dönmez. Bypass edilebilecek bir yol bırakılmamıştır.
 */
export function startOperation(wo: WorkOrder, seq: number): WorkOrder {
  if (wo.status !== "released" && wo.status !== "in_progress") {
    throw new BusinessRuleError(
      `İş emri "${wo.status}" durumunda; operasyon başlatılamaz. Önce serbest bırakın.`,
      "work_order_not_released",
    );
  }

  const op = requireOperation(wo, seq);
  if (op.state !== "pending") {
    throw new BusinessRuleError(
      `Operasyon ${seq} "${op.state}" durumunda; yeniden başlatılamaz.`,
      "invalid_transition",
    );
  }

  const previous = wo.operations.filter((o) => o.seq < seq).sort((a, b) => b.seq - a.seq)[0];
  if (previous && !isCleared(previous)) {
    const why =
      previous.gate && previous.state === "gate_hold"
        ? `Operasyon ${previous.seq} kalite kapısında bekliyor ("${previous.gate.characteristic}").`
        : previous.gate && previous.state === "gate_failed"
          ? `Operasyon ${previous.seq} kalite kapısından GEÇEMEDİ.`
          : `Operasyon ${previous.seq} henüz tamamlanmadı ("${previous.state}").`;
    throw new BusinessRuleError(
      `${why} Operasyon ${seq} başlatılamaz — kalite kapısı geçilmeden sonraki ` +
        `operasyona aktarım yapılamaz.`,
      "quality_gate_blocked",
    );
  }

  return replaceOperation(wo, seq, { state: "running" }, { status: "in_progress" });
}

/** Operasyonu teyit eder. Kapısı varsa doğrudan geçmez — beklemeye alınır. */
export function confirmOperation(
  wo: WorkOrder,
  seq: number,
  input: { confirmedQty: number; scrapQty?: number },
): WorkOrder {
  const op = requireOperation(wo, seq);
  if (op.state !== "running") {
    throw new BusinessRuleError(
      `Operasyon ${seq} çalışmıyor ("${op.state}"); teyit edilemez.`,
      "invalid_transition",
    );
  }
  const scrap = input.scrapQty ?? 0;
  if (input.confirmedQty < 0 || scrap < 0) {
    throw new BusinessRuleError("Miktarlar negatif olamaz.", "negative_quantity");
  }
  if (input.confirmedQty + scrap > wo.quantity) {
    throw new BusinessRuleError(
      `Teyit + fire (${input.confirmedQty + scrap}) iş emri miktarını (${wo.quantity}) aşamaz.`,
      "quantity_exceeds_order",
    );
  }

  return replaceOperation(wo, seq, {
    state: op.gate ? "gate_hold" : "confirmed",
    confirmedQty: input.confirmedQty,
    scrapQty: scrap,
  });
}

/** Kalite kararı. Yalnızca kapının tanımladığı izne sahip kişi verebilir. */
export function recordGateDecision(
  wo: WorkOrder,
  seq: number,
  input: {
    decision: "pass" | "fail";
    principal: Principal;
    at: string;
    measurement?: number;
    reason?: string;
  },
): WorkOrder {
  const op = requireOperation(wo, seq);
  if (!op.gate) {
    throw new BusinessRuleError(`Operasyon ${seq} için kalite kapısı tanımlı değil.`, "no_gate");
  }
  if (op.state !== "gate_hold") {
    throw new BusinessRuleError(
      `Operasyon ${seq} kalite kararı bekler durumda değil ("${op.state}").`,
      "invalid_transition",
    );
  }
  if (!holds(input.principal, op.gate.decidedBy)) {
    throw new BusinessRuleError(
      `Kalite kararı için "${op.gate.decidedBy}" izni gerekir. ` +
        `PASS yetkisi olmayan kullanıcı kapıyı açamaz.`,
      "gate_permission_denied",
    );
  }

  // Tolerans tanımlıysa ölçüm zorunludur ve karar ölçümle tutarlı olmalıdır.
  const tol = op.gate.tolerance;
  if (tol) {
    if (input.measurement === undefined) {
      throw new BusinessRuleError(
        `"${op.gate.characteristic}" için ölçüm değeri zorunludur (${tol.min}-${tol.max} ${tol.unit}).`,
        "measurement_required",
      );
    }
    const inRange = input.measurement >= tol.min && input.measurement <= tol.max;
    if (input.decision === "pass" && !inRange) {
      throw new BusinessRuleError(
        `Ölçüm ${input.measurement} ${tol.unit}, tolerans dışı (${tol.min}-${tol.max}). ` +
          `Tolerans dışı değerle PASS verilemez; override gerekiyorsa yetkili kullanıcı ` +
          `gerekçesiyle atlamalıdır.`,
        "measurement_out_of_tolerance",
      );
    }
  }

  if (input.decision === "fail" && !input.reason?.trim()) {
    throw new BusinessRuleError(
      "FAIL kararı için neden zorunludur.",
      "reason_required",
    );
  }

  const decision: GateDecision = {
    decision: input.decision,
    by: input.principal.userId,
    at: input.at,
    measurement: input.measurement ?? null,
    reason: input.reason ?? null,
    overridden: false,
  };

  return replaceOperation(wo, seq, {
    state: input.decision === "pass" ? "gate_passed" : "gate_failed",
    gateDecision: decision,
  });
}

/**
 * Kalite kapısını atlar.
 *
 * Yasak değil, görünür. L2 yetki + gerekçe ister, iş emrinde kalıcı iz bırakır
 * ve `overrideCount` Boss Mode'un regülasyon sağlık skoruna girer.
 */
export function overrideGate(
  wo: WorkOrder,
  seq: number,
  input: { principal: Principal; at: string; reason: string },
): WorkOrder {
  const op = requireOperation(wo, seq);
  if (!op.gate) {
    throw new BusinessRuleError(`Operasyon ${seq} için kalite kapısı yok.`, "no_gate");
  }
  if (op.state !== "gate_hold" && op.state !== "gate_failed") {
    throw new BusinessRuleError(
      `Operasyon ${seq} "${op.state}" durumunda; atlanacak bir kapı yok.`,
      "invalid_transition",
    );
  }
  if (input.principal.maxAuthority < 2) {
    throw new BusinessRuleError(
      "Kalite kapısı atlamak L2 yetki gerektirir.",
      "authority_insufficient",
    );
  }
  if (!input.reason.trim()) {
    throw new BusinessRuleError("Kapı atlamak için gerekçe zorunludur.", "reason_required");
  }

  return replaceOperation(
    wo,
    seq,
    {
      state: "gate_passed",
      gateDecision: {
        decision: "pass",
        by: input.principal.userId,
        at: input.at,
        measurement: null,
        reason: input.reason,
        overridden: true,
      },
    },
    { overrideCount: wo.overrideCount + 1 },
  );
}

/** Tüm operasyonlar geçmeden iş emri tamamlanamaz. */
export function completeWorkOrder(wo: WorkOrder): WorkOrder {
  if (wo.status !== "in_progress") {
    throw new BusinessRuleError(
      `İş emri "${wo.status}" durumunda; tamamlanamaz.`,
      "invalid_transition",
    );
  }
  const blocking = wo.operations.filter((o) => !isCleared(o));
  if (blocking.length > 0) {
    throw new BusinessRuleError(
      `${blocking.length} operasyon tamamlanmadı (${blocking.map((o) => `#${o.seq}:${o.state}`).join(", ")}). ` +
        `İş emri kapatılamaz.`,
      "operations_incomplete",
    );
  }
  return { ...wo, status: "completed" };
}

/** İş emrinin bir sonraki yapılabilir adımı — modelin kullanıcıya söyleyeceği şey. */
export function nextAction(wo: WorkOrder): string {
  if (wo.status === "created") return "İş emri serbest bırakılmalı (BOM revizyonu dondurulacak).";
  if (wo.status === "completed" || wo.status === "technically_closed") return "İş emri tamamlandı.";

  const hold = wo.operations.find((o) => o.state === "gate_hold");
  if (hold) return `Operasyon ${hold.seq} kalite kararı bekliyor: "${hold.gate?.characteristic}".`;

  const failed = wo.operations.find((o) => o.state === "gate_failed");
  if (failed) return `Operasyon ${failed.seq} kalite kapısından geçemedi; rework veya yetkili override gerekiyor.`;

  const running = wo.operations.find((o) => o.state === "running");
  if (running) return `Operasyon ${running.seq} çalışıyor; teyit bekleniyor.`;

  const next = wo.operations.find((o) => o.state === "pending");
  if (next) return `Sıradaki operasyon ${next.seq} (${next.workCenter}) başlatılabilir.`;

  return "Tüm operasyonlar tamam; iş emri kapatılabilir.";
}
