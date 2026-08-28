/**
 * Approval Workspace — sekiz durumlu onay akışı.
 *
 * Ürün Mantığı §10'daki durum makinesinin kod karşılığı. Üç kontrol
 * YAPISAL olarak kuruludur; hiçbiri "kullanıcı dikkatli olsun" değildir:
 *
 *  1. GÖREVLER AYRILIĞI — taslağı hazırlayan onaylayamaz. Aynı kişinin
 *     hem hazırlayıp hem onaylaması, iç kontrolün en temel ihlalidir.
 *
 *  2. ONAY LİMİTİ — onaylayanın tutar limiti belgeden küçükse tek başına
 *     onaylayamaz; belge üst yetkiye eskale olur.
 *
 *  3. L4 SINIRI — `submitted_externally` durumuna KULLANICI GEÇİREMEZ.
 *     Resmî gönderimi KAELON yapmaz; entegratör yapar ve sonucu geri bildirir.
 *     Bu yüzden o geçiş yalnızca `job` kanalından (entegrasyon işi) kabul
 *     edilir. Sohbetten veya arayüzden "gönderildi" işaretlenemez — aksi
 *     hâlde hiç gönderilmemiş bir beyanname gönderilmiş görünürdü.
 */

import { BusinessRuleError } from "../../kernel/errors.js";
import type { Channel, Money, Principal } from "../../kernel/types.js";

export type ApprovalState =
  | "preparing"
  | "ready_for_review"
  | "returned_for_correction"
  | "approved"
  | "submitted_externally"
  | "accepted"
  | "rejected"
  | "archived";

export type ApprovalKind =
  | "vat_return"
  | "termination_settlement"
  | "payment_plan"
  | "invoice_acceptance"
  | "purchase_order"
  | "production_closure"
  | "quality_release";

export interface ApprovalEvent {
  readonly at: string;
  readonly from: ApprovalState;
  readonly to: ApprovalState;
  readonly by: string;
  readonly channel: Channel;
  readonly note: string | null;
}

export interface ApprovalWorkspace {
  readonly id: string;
  readonly kind: ApprovalKind;
  readonly title: string;
  readonly state: ApprovalState;
  /** Taslağı hazırlayan. Onaylayan bu kişi OLAMAZ. */
  readonly preparedBy: string;
  readonly approvedBy: string | null;
  /** Belgenin parasal büyüklüğü — onay limiti kontrolü için. */
  readonly amount: Money | null;
  /** Onay için gereken izin. */
  readonly requiredPermission: string;
  /** Taslağın içeriği — kind'e göre değişir. */
  readonly payload: unknown;
  /** Hazırlık sırasında bulunan riskler; onaylayan bunları görmek zorundadır. */
  readonly risks: readonly string[];
  readonly history: readonly ApprovalEvent[];
}

const ALLOWED: Record<ApprovalState, readonly ApprovalState[]> = {
  preparing: ["ready_for_review"],
  ready_for_review: ["approved", "returned_for_correction"],
  returned_for_correction: ["ready_for_review", "archived"],
  approved: ["submitted_externally", "archived"],
  submitted_externally: ["accepted", "rejected"],
  accepted: ["archived"],
  rejected: ["returned_for_correction", "archived"],
  archived: [],
};

function transition(
  ws: ApprovalWorkspace,
  to: ApprovalState,
  by: string,
  channel: Channel,
  at: string,
  note: string | null,
  patch: Partial<ApprovalWorkspace> = {},
): ApprovalWorkspace {
  if (!ALLOWED[ws.state].includes(to)) {
    throw new BusinessRuleError(
      `"${ws.state}" durumundan "${to}" durumuna geçilemez. ` +
        `İzin verilen: ${ALLOWED[ws.state].join(", ") || "yok (son durum)"}.`,
      "invalid_transition",
    );
  }
  return {
    ...ws,
    ...patch,
    state: to,
    history: [...ws.history, { at, from: ws.state, to, by, channel, note }],
  };
}

export function createWorkspace(input: {
  id: string;
  kind: ApprovalKind;
  title: string;
  preparedBy: string;
  amount?: Money | null;
  requiredPermission: string;
  payload: unknown;
  risks?: readonly string[];
  at: string;
}): ApprovalWorkspace {
  return {
    id: input.id,
    kind: input.kind,
    title: input.title,
    state: "preparing",
    preparedBy: input.preparedBy,
    approvedBy: null,
    amount: input.amount ?? null,
    requiredPermission: input.requiredPermission,
    payload: input.payload,
    risks: input.risks ?? [],
    history: [
      {
        at: input.at,
        from: "preparing",
        to: "preparing",
        by: input.preparedBy,
        channel: "job",
        note: "taslak oluşturuldu",
      },
    ],
  };
}

export function submitForReview(
  ws: ApprovalWorkspace,
  input: { principal: Principal; channel: Channel; at: string },
): ApprovalWorkspace {
  return transition(ws, "ready_for_review", input.principal.userId, input.channel, input.at, null);
}

export interface ApproveOptions {
  readonly principal: Principal;
  readonly channel: Channel;
  readonly at: string;
  readonly note?: string;
  /** Onaylayanın riskleri gördüğünü teyidi. Riskli belgede zorunlu. */
  readonly risksAcknowledged?: boolean;
}

export function approve(ws: ApprovalWorkspace, input: ApproveOptions): ApprovalWorkspace {
  // ── Kontrol 1: görevler ayrılığı
  if (ws.preparedBy === input.principal.userId) {
    throw new BusinessRuleError(
      "Taslağı hazırlayan kişi onaylayamaz. Onay, hazırlıktan bağımsız bir kişiden gelmelidir.",
      "segregation_of_duties",
    );
  }

  // ── Kontrol 2: yetki
  const hasPermission =
    input.principal.permissions.has(ws.requiredPermission as never) ||
    input.principal.permissions.has(
      `${ws.requiredPermission.split(":")[0]}:*` as never,
    );
  if (!hasPermission) {
    throw new BusinessRuleError(
      `Bu belgeyi onaylamak için "${ws.requiredPermission}" izni gerekir.`,
      "approval_permission_denied",
    );
  }

  // ── Kontrol 3: onay limiti
  if (ws.amount) {
    const limit = input.principal.approvalLimit;
    if (!limit) {
      throw new BusinessRuleError(
        `Tutarlı belge onayı için tanımlı bir onay limitiniz yok (${ws.amount.amount} ${ws.amount.currency}).`,
        "approval_limit_missing",
      );
    }
    if (limit.currency !== ws.amount.currency) {
      throw new BusinessRuleError(
        `Onay limitiniz ${limit.currency}, belge ${ws.amount.currency}. Kur çevrimi olmadan onaylanamaz.`,
        "approval_limit_currency_mismatch",
      );
    }
    if (ws.amount.amount > limit.amount) {
      throw new BusinessRuleError(
        `Belge tutarı ${ws.amount.amount} ${ws.amount.currency}, onay limitiniz ${limit.amount} ${limit.currency}. ` +
          `Üst yetkiye eskale edilmeli.`,
        "approval_limit_exceeded",
      );
    }
  }

  // ── Kontrol 4: riskler görüldü mü?
  if (ws.risks.length > 0 && !input.risksAcknowledged) {
    throw new BusinessRuleError(
      `Bu belgede ${ws.risks.length} risk işaretli. Onaylamadan önce riskler açıkça teyit edilmelidir.`,
      "risks_not_acknowledged",
    );
  }

  return transition(
    ws,
    "approved",
    input.principal.userId,
    input.channel,
    input.at,
    input.note ?? null,
    { approvedBy: input.principal.userId },
  );
}

export function returnForCorrection(
  ws: ApprovalWorkspace,
  input: { principal: Principal; channel: Channel; at: string; reason: string },
): ApprovalWorkspace {
  if (!input.reason.trim()) {
    throw new BusinessRuleError("Düzeltme talebi gerekçesiz gönderilemez.", "reason_required");
  }
  return transition(
    ws,
    "returned_for_correction",
    input.principal.userId,
    input.channel,
    input.at,
    input.reason,
  );
}

/**
 * Dış sisteme gönderildiğini KAYDEDER — göndermez.
 *
 * Yalnızca `job` kanalından kabul edilir: entegratör işi webhook'u işlerken
 * çağırır. Bir kullanıcı sohbetten veya arayüzden bunu işaretleyemez, çünkü
 * o zaman hiç gönderilmemiş bir belge "gönderildi" görünürdü ve L4 sınırı
 * kâğıt üstünde kalırdı.
 */
export function recordExternalSubmission(
  ws: ApprovalWorkspace,
  input: { channel: Channel; at: string; integrator: string; reference: string },
): ApprovalWorkspace {
  if (input.channel !== "job") {
    throw new BusinessRuleError(
      "Dış gönderim durumu yalnızca entegrasyon işi tarafından kaydedilebilir. " +
        "KAELON resmî gönderim yapmaz; entegratör yapar ve sonucu bildirir.",
      "external_submission_channel",
    );
  }
  return transition(
    ws,
    "submitted_externally",
    `integrator:${input.integrator}`,
    input.channel,
    input.at,
    `referans: ${input.reference}`,
  );
}

export function recordExternalResult(
  ws: ApprovalWorkspace,
  input: { channel: Channel; at: string; accepted: boolean; detail: string },
): ApprovalWorkspace {
  if (input.channel !== "job") {
    throw new BusinessRuleError(
      "Dış sistem sonucu yalnızca entegrasyon işi tarafından kaydedilebilir.",
      "external_result_channel",
    );
  }
  return transition(
    ws,
    input.accepted ? "accepted" : "rejected",
    "integrator",
    input.channel,
    input.at,
    input.detail,
  );
}

export function archive(
  ws: ApprovalWorkspace,
  input: { principal: Principal; channel: Channel; at: string },
): ApprovalWorkspace {
  return transition(ws, "archived", input.principal.userId, input.channel, input.at, null);
}

/** Belgenin şu an kimden ne beklediği — modelin kullanıcıya söyleyeceği şey. */
export function pendingOn(ws: ApprovalWorkspace): string {
  switch (ws.state) {
    case "preparing":
      return "KAELON taslağı hazırlıyor.";
    case "ready_for_review":
      return `"${ws.requiredPermission}" iznine sahip, taslağı hazırlayan dışında bir yetkilinin incelemesi bekleniyor.`;
    case "returned_for_correction":
      return "Düzeltme istendi; taslak yeniden hazırlanmalı.";
    case "approved":
      return "Onaylandı. Resmî gönderim yetkili insan ve entegratör tarafından yapılacak — KAELON göndermez.";
    case "submitted_externally":
      return "Entegratöre iletildi; dış sistem sonucu bekleniyor.";
    case "accepted":
      return "Dış sistem kabul etti; süreç tamamlandı.";
    case "rejected":
      return "Dış sistem reddetti; gerekçe geçmişte kayıtlı.";
    case "archived":
      return "Arşivlendi.";
  }
}
