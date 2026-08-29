/**
 * Boss Mode nöbetçileri (sentinels).
 *
 * Anayasa Katman II/4: "Seviye seçimi bir EŞİK fonksiyonudur: tespitin
 * ciddiyeti (etkilenen tutar / oran) bir eşiği aşıyor mu? Seviye 0 = eşik
 * altı; Seviye 1 = dikkat eşiği; Seviye 2 = zarar eşiği."
 *
 * Buradaki en önemli iki karar:
 *
 *  1. SEVİYE TASARIM DEĞİL, HESAP. Bir bulgunun "kritik" olması, birinin
 *     onu kritik yazmasıyla değil, parasal etkisinin eşiği aşmasıyla olur.
 *     Eşikler tenant bazlıdır — 156.000 TL bir fabrikada kriz, diğerinde
 *     yuvarlama hatasıdır.
 *
 *  2. PROAKTİFLİK ROLE BAĞLIDIR, KULLANICIYA DEĞİL. Depo sorumlusu nakit
 *     uyarısı almaz; göremediği için değil, o uyarıyı ALMAMASI gerektiği
 *     için. Her nöbetçi bir izin talep eder; izni olmayan role o nöbetçi
 *     hiç koşturulmaz.
 */

import type { Permission } from "../../kernel/types.js";

export type SignalLevel = 0 | 1 | 2;

export interface BriefingThresholds {
  /** Bu tutarın üstü "dikkat" (Seviye 1). */
  readonly noticeAmount: number;
  /** Bu tutarın üstü "zarar" (Seviye 2). */
  readonly criticalAmount: number;
  readonly currency: string;
  /** Üretim hızı hedefin bu oranın altındaysa dikkat. */
  readonly rateShortfallNotice: number;
  readonly rateShortfallCritical: number;
  /** İstasyon doluluğu bu yüzdenin üstündeyse darboğaz. */
  readonly utilizationNotice: number;
  readonly utilizationCritical: number;
}

export const DEFAULT_THRESHOLDS: BriefingThresholds = {
  noticeAmount: 25_000,
  criticalAmount: 100_000,
  currency: "TRY",
  rateShortfallNotice: 0.1,
  rateShortfallCritical: 0.2,
  utilizationNotice: 88,
  utilizationCritical: 95,
};

export interface Signal {
  readonly id: string;
  readonly level: SignalLevel;
  readonly title: string;
  readonly detail: string;
  /** Parasal etki; yoksa null. Sıralama ve eşik bunun üzerinden. */
  readonly impact: number | null;
  /** Kullanıcı detaya inmek isterse çağrılacak tool. */
  readonly drilldown: { readonly tool: string; readonly input: unknown } | null;
}

export interface Sentinel {
  readonly id: string;
  readonly tool: string;
  readonly input: unknown;
  /** Bu nöbetçi yalnızca bu izne sahip rollerde koşar. */
  readonly requires: Permission;
  readonly evaluate: (data: unknown, t: BriefingThresholds) => readonly Signal[];
}

/** Parasal etkiyi seviyeye çevirir — tek yer, tek kural. */
export function levelForAmount(amount: number, t: BriefingThresholds): SignalLevel {
  const abs = Math.abs(amount);
  if (abs >= t.criticalAmount) return 2;
  if (abs >= t.noticeAmount) return 1;
  return 0;
}

const tl = (n: number): string => n.toLocaleString("tr-TR");

export const SENTINELS: readonly Sentinel[] = [
  {
    id: "shipment_delay",
    tool: "get_shipment_risk",
    input: { isoWeek: 19 },
    requires: "operations:shipment.read",
    evaluate(data, t) {
      const rows = data as { salesOrder: string; customer: string; slipDays: number; penaltyRiskTry: number }[];
      if (!Array.isArray(rows) || rows.length === 0) return [];
      const total = rows.reduce((s, r) => s + r.penaltyRiskTry, 0);
      const worst = [...rows].sort((a, b) => b.slipDays - a.slipDays)[0]!;
      const level = levelForAmount(total, t);
      if (level === 0) return [];
      return [
        {
          id: "shipment_delay",
          level,
          title: `${worst.customer} ${worst.salesOrder} ${worst.slipDays} gün gecikecek.`,
          detail:
            `${rows.length} sipariş risk altında. Toplam sözleşme cezası riski ` +
            `yaklaşık ${tl(total)} ${t.currency}.`,
          impact: total,
          drilldown: { tool: "get_shipment_risk", input: { isoWeek: 19 } },
        },
      ];
    },
  },

  {
    id: "production",
    tool: "get_factory_wip",
    input: {},
    requires: "operations:workorder.read",
    evaluate(data, t) {
      const w = data as {
        actualRatePerHour: number;
        targetRatePerHour: number;
        machinesRunning: number;
        machinesTotal: number;
        stations: { station: string; utilizationPct: number; note: string }[];
      };
      if (!w?.stations) return [];
      const out: Signal[] = [];

      const shortfall = 1 - w.actualRatePerHour / w.targetRatePerHour;
      if (shortfall >= t.rateShortfallNotice) {
        out.push({
          id: "production_rate",
          level: shortfall >= t.rateShortfallCritical ? 2 : 1,
          title: `Üretim hızı hedefin %${Math.round(shortfall * 100)} altında.`,
          detail: `Gerçek ${w.actualRatePerHour} birim/saat, hedef ${w.targetRatePerHour}.`,
          impact: null,
          drilldown: { tool: "get_factory_wip", input: {} },
        });
      }

      const worst = [...w.stations].sort((a, b) => b.utilizationPct - a.utilizationPct)[0];
      if (worst && worst.utilizationPct >= t.utilizationNotice) {
        out.push({
          id: "bottleneck",
          level: worst.utilizationPct >= t.utilizationCritical ? 2 : 1,
          title: `${worst.station} darboğaz — %${worst.utilizationPct} dolulukta.`,
          detail: worst.note,
          impact: null,
          drilldown: { tool: "get_factory_wip", input: {} },
        });
      }

      const offline = w.machinesTotal - w.machinesRunning;
      if (offline >= Math.ceil(w.machinesTotal * 0.15)) {
        out.push({
          id: "machines_offline",
          level: 1,
          title: `${offline} makine plan dışı duruşta.`,
          detail: `${w.machinesRunning}/${w.machinesTotal} makine çalışıyor.`,
          impact: null,
          drilldown: { tool: "get_factory_wip", input: {} },
        });
      }
      return out;
    },
  },

  {
    id: "blocked_invoices",
    tool: "list_blocked_invoices",
    input: { status: "blocked" },
    requires: "documents:invoice.read",
    evaluate(data, t) {
      const rows = data as { documentNo: string; totalVariance: number; topFinding: string | null }[];
      if (!Array.isArray(rows) || rows.length === 0) return [];
      const total = rows.reduce((s, r) => s + Math.abs(r.totalVariance), 0);
      const level = levelForAmount(total, t);
      if (level === 0) return [];
      const worst = [...rows].sort((a, b) => Math.abs(b.totalVariance) - Math.abs(a.totalVariance))[0]!;
      return [
        {
          id: "blocked_invoices",
          level,
          title: `${rows.length} fatura eşleştirmede bloklandı.`,
          detail: `Toplam sapma ${tl(total)} ${t.currency}. En büyüğü: ${worst.topFinding ?? worst.documentNo}`,
          impact: total,
          drilldown: { tool: "list_blocked_invoices", input: { status: "blocked" } },
        },
      ];
    },
  },

  {
    id: "pending_approvals",
    tool: "list_pending_approvals",
    input: { state: "ready_for_review" },
    requires: "approval:read",
    evaluate(data) {
      const rows = data as { id: string; title: string; amount: { amount: number; currency: string } | null }[];
      if (!Array.isArray(rows) || rows.length === 0) return [];
      return [
        {
          id: "pending_approvals",
          level: 1,
          title: `${rows.length} belge onayınızı bekliyor.`,
          detail: rows.map((r) => r.title).slice(0, 3).join(" · "),
          impact: null,
          drilldown: { tool: "list_pending_approvals", input: { state: "ready_for_review" } },
        },
      ];
    },
  },

  {
    id: "overtime_pending",
    tool: "get_overtime",
    input: { employeeQuery: null, department: null, period: "2026-05" },
    requires: "hr:overtime.read",
    evaluate(data) {
      const rows = data as { pendingApprovalMinutes: number }[];
      if (!Array.isArray(rows)) return [];
      const pending = rows.reduce((s, r) => s + (r.pendingApprovalMinutes ?? 0), 0);
      if (pending < 120) return [];
      return [
        {
          id: "overtime_pending",
          level: 1,
          title: `${Math.round(pending / 60)} saat mesai yönetici onayı bekliyor.`,
          detail: "Onaylanmadan bordroya girmez; tutarlar kesinleşmemiştir.",
          impact: null,
          drilldown: {
            tool: "get_overtime",
            input: { employeeQuery: null, department: null, period: "2026-05" },
          },
        },
      ];
    },
  },
];
