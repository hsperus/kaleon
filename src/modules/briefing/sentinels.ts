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
  /**
   * Tool girdisi.
   *
   * FONKSİYON OLABİLİR ÇÜNKÜ BAZI NÖBETÇİLER TARİHE BAĞLIDIR. "Bu ayın
   * bordrosu çalıştı mı" sorusu sabit bir girdiyle sorulamaz; sabit
   * yazılsaydı nöbetçi bir ay sonra yanlış ayı kontrol ederdi ve
   * kimse fark etmezdi.
   */
  readonly input: unknown | ((now: Date) => unknown);
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
      // Alanlar null olabilir: "bilinmiyor" ile "sıfır" ayrı şeylerdir.
      // Bilinmeyen bir sayıyla eşik karşılaştırmak NaN üretir; NaN her
      // karşılaştırmada false döner ve sinyal SESSİZCE kaybolur. Sessiz
      // kayıp, Boss Mode'un tek işini yapmaması demektir.
      const w = data as {
        actualRatePerHour: number | null;
        targetRatePerHour: number | null;
        machinesRunning: number | null;
        machinesTotal: number | null;
        stations: { station: string; utilizationPct: number | null; note: string }[];
      };
      if (!w?.stations) return [];
      const out: Signal[] = [];

      const shortfall =
        w.actualRatePerHour !== null && w.targetRatePerHour
          ? 1 - w.actualRatePerHour / w.targetRatePerHour
          : null;
      if (shortfall !== null && shortfall >= t.rateShortfallNotice) {
        out.push({
          id: "production_rate",
          level: shortfall >= t.rateShortfallCritical ? 2 : 1,
          title: `Üretim hızı hedefin %${Math.round(shortfall * 100)} altında.`,
          detail: `Gerçek ${w.actualRatePerHour} birim/saat, hedef ${w.targetRatePerHour}.`,
          impact: null,
          drilldown: { tool: "get_factory_wip", input: {} },
        });
      }

      const measured = w.stations.filter(
        (s): s is typeof s & { utilizationPct: number } => s.utilizationPct !== null,
      );
      const worst = [...measured].sort((a, b) => b.utilizationPct - a.utilizationPct)[0];
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

      const offline =
        w.machinesTotal !== null && w.machinesRunning !== null
          ? w.machinesTotal - w.machinesRunning
          : null;
      if (offline !== null && offline >= Math.ceil(w.machinesTotal! * 0.15)) {
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

  /*
   * ── MALİ NÖBETÇİLER ──
   *
   * NÖBETÇİLER BEŞ TANEYDİ VE HEPSİ ÜRETİM/SEVKİYAT TARAFINDAYDI.
   * Muhasebe, bordro ve sabit kıymet hiç izlenmiyordu: bilanço denk
   * olmasa, ayın bordrosu unutulsa ya da amortisman hiç ayrılmasa
   * sistem tek kelime etmiyordu. Bunlar sorulduğunda değil,
   * OLDUĞUNDA öğrenilmesi gereken şeylerdir.
   */
  {
    id: "balance-sheet-integrity",
    tool: "get_balance_sheet",
    input: (now: Date) => ({ asOf: now.toISOString().slice(0, 10) }),
    requires: "accounting:ledger.read",
    evaluate: (data) => {
      const d = data as { balanced?: boolean; difference?: number } | null;
      if (!d || d.balanced !== false) return [];
      const diff = typeof d.difference === "number" ? d.difference : null;
      return [
        {
          id: "balance-sheet-unbalanced",
          // BİLANÇONUN DENK OLMAMASI HER ZAMAN KRİTİKTİR: tutarın
          // büyüklüğüne bakılmaz, çünkü sorun tutar değil güvendir.
          level: 2,
          title: "Bilanço denk değil.",
          detail:
            diff === null
              ? "Aktif ile pasif toplamı tutmuyor; tek taraflı kayıt var."
              : `Aktif ile pasif arasında ${tl(Math.abs(diff))} TL fark var. ` +
                `Tüm mali tablolar bu fark giderilene kadar şüphelidir.`,
          impact: diff,
          drilldown: { tool: "get_balance_sheet", input: {} },
        },
      ];
    },
  },
  {
    id: "fixed-asset-reconciliation",
    tool: "list_fixed_assets",
    input: { status: "hepsi" },
    requires: "accounting:ledger.read",
    evaluate: (data) => {
      const d = data as {
        reconciliation?: { matched?: boolean; costDifference?: number; accumulatedDifference?: number };
      } | null;
      const r = d?.reconciliation;
      if (!r || r.matched !== false) return [];
      const diff = Math.abs(r.costDifference ?? 0) + Math.abs(r.accumulatedDifference ?? 0);
      return [
        {
          id: "fixed-asset-drift",
          level: levelForAmount(diff, DEFAULT_THRESHOLDS),
          title: "Sabit kıymet kaydı defterle uyuşmuyor.",
          detail:
            `Kıymet listesi ile muhasebe defteri arasında ${tl(diff)} TL fark var. ` +
            `Bilanço ile kıymet listesi farklı rakam söylüyor.`,
          impact: diff,
          drilldown: { tool: "list_fixed_assets", input: { status: "hepsi" } },
        },
      ];
    },
  },
  {
    id: "payroll-missing",
    tool: "get_payroll_summary",
    /*
     * GEÇEN AYIN BORDROSU KONTROL EDİLİR, BU AYIN DEĞİL.
     *
     * Ayın 3'ünde "bu ayın bordrosu yok" demek gürültüdür — daha
     * çalıştırılmasının vakti gelmemiştir. Geçen ay bitmiştir ve
     * bordrosu çalışmış olmalıdır.
     */
    input: (now: Date) => {
      const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15));
      return { period: prev.toISOString().slice(0, 10) };
    },
    requires: "hr:payroll.read",
    evaluate: (data) => {
      // Bordro varsa `data` dolu döner; yoksa null.
      if (data !== null && data !== undefined) return [];
      return [
        {
          id: "payroll-not-run",
          level: 2,
          title: "Geçen ayın bordrosu çalıştırılmamış.",
          detail:
            "Bordro çalıştırılmadan personel gideri deftere girmez ve SGK bildirimi " +
            "yapılamaz. Ödemeler yapılmış olsa bile muhasebe kaydı eksiktir.",
          impact: null,
          drilldown: { tool: "get_payroll_summary", input: {} },
        },
      ];
    },
  },
  {
    id: "einvoice-queue",
    tool: "list_pending_einvoices",
    input: { limit: 50 },
    requires: "documents:einvoice.read",
    evaluate: (data) => {
      const d = data as { invoices?: readonly unknown[]; total?: number } | null;
      const count = d?.invoices?.length ?? 0;
      if (count === 0) return [];
      const total = typeof d?.total === "number" ? d.total : null;
      return [
        {
          id: "einvoice-pending",
          level: levelForAmount(total ?? 0, DEFAULT_THRESHOLDS),
          title: `${count} e-Fatura entegratöre gönderilmeyi bekliyor.`,
          detail:
            total === null
              ? "Belgesi üretilmiş ama gönderilmemiş faturalar var."
              : `Toplam ${tl(total)} TL tutarında fatura gönderim kuyruğunda; ` +
                `gönderilmeyen fatura mevzuat açısından kesilmemiş sayılmaz ama ` +
                `alıcıya ulaşmaz ve tahsilat gecikir.`,
          impact: total,
          drilldown: { tool: "list_pending_einvoices", input: { limit: 50 } },
        },
      ];
    },
  },
];
