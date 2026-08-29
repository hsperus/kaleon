"use client";

/**
 * Panel bileşenleri.
 *
 * Panel, cevabın YERİNE geçmez; cevabın altındaki veriyi gösterir. Model
 * "boya darboğaz" der, panel hangi istasyonun yüzde kaçta olduğunu gösterir.
 * İkisi aynı tool sonucundan beslenir — panelde model yorumu yoktur, ham veri
 * vardır. Bu ayrım önemli: yorum yanılabilir, veri kaynaklıdır.
 */

import type { ReactNode } from "react";

export interface PanelPayload {
  readonly tool: string;
  readonly data: unknown;
  readonly sources: readonly { system: string; syncedAt: string; recordCount?: number }[];
}

const tl = (n: unknown): string => Number(n ?? 0).toLocaleString("tr-TR");

/** Bu tool'ların sonucu panelde gösterilir; diğerleri yalnızca metin olarak. */
export const PANEL_TOOLS = new Set([
  "get_factory_wip",
  "get_shipment_risk",
  "get_bank_balance",
  "get_overtime",
  "match_invoice",
]);

export function Panel({ payload, onClose }: { payload: PanelPayload; onClose: () => void }) {
  return (
    <article className="panel">
      <div className="panel-head">
        <h3>{TITLES[payload.tool] ?? payload.tool}</h3>
        <button className="panel-x" onClick={onClose} aria-label="Paneli kapat">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
      <div className="panel-body">
        <Body payload={payload} />
        <div className="panel-src">
          {payload.sources.map((s, i) => (
            <span key={i}>
              {s.system}
              {s.recordCount !== undefined ? ` · ${s.recordCount} kayıt` : ""}
            </span>
          ))}
        </div>
      </div>
    </article>
  );
}

const TITLES: Record<string, string> = {
  get_factory_wip: "Fabrika Canlı",
  get_shipment_risk: "Sevkiyat Riski",
  get_bank_balance: "Banka Pozisyonu",
  get_overtime: "Mesai",
  match_invoice: "Fatura Eşleştirme",
};

function Body({ payload }: { payload: PanelPayload }): ReactNode {
  const d = payload.data as Record<string, unknown>;

  if (payload.tool === "get_factory_wip") {
    const w = d as unknown as {
      activeWorkOrders: number;
      staffOnShift: number;
      staffPlanned: number;
      machinesRunning: number;
      machinesTotal: number;
      actualRatePerHour: number;
      targetRatePerHour: number;
      stations: { station: string; utilizationPct: number; note: string }[];
    };
    return (
      <>
        <p>
          {w.activeWorkOrders} aktif iş emri · {w.staffOnShift}/{w.staffPlanned} personel ·{" "}
          {w.machinesRunning}/{w.machinesTotal} makine
        </p>
        <div className="meters">
          {w.stations.map((s) => (
            <div className="st" key={s.station}>
              <div className="st-top">
                <span className="n">{s.station}</span>
                <span className="v">%{s.utilizationPct}</span>
              </div>
              <div className="bar">
                <i
                  className={s.utilizationPct >= 90 ? "r" : s.utilizationPct >= 80 ? "y" : ""}
                  style={{ width: `${s.utilizationPct}%` }}
                />
              </div>
              <div className="st-note">{s.note}</div>
            </div>
          ))}
        </div>
        <div className="kv">
          <span>Gerçek hız</span>
          <b>{w.actualRatePerHour} br/sa</b>
        </div>
        <div className="kv">
          <span>Hedef hız</span>
          <b>{w.targetRatePerHour} br/sa</b>
        </div>
      </>
    );
  }

  if (payload.tool === "get_shipment_risk") {
    const rows = payload.data as {
      salesOrder: string;
      customer: string;
      committedDate: string;
      estimatedDate: string;
      slipDays: number;
      penaltyRiskTry: number;
    }[];
    return (
      <>
        {rows.map((r) => (
          <div className="rrow" key={r.salesOrder}>
            <i className={`rdot ${r.slipDays >= 3 ? "r" : "y"}`} />
            <div className="rmain">
              <div className="n">
                {r.customer} {r.salesOrder}
              </div>
              <div className="s">
                Taahhüt {r.committedDate} · tahmini {r.estimatedDate}
              </div>
            </div>
            <div className={`rval ${r.slipDays >= 3 ? "r" : "y"}`}>+{r.slipDays} gün</div>
          </div>
        ))}
        <div className="kv">
          <span>Toplam ceza riski</span>
          <b style={{ color: "var(--crit)" }}>
            {tl(rows.reduce((s, r) => s + r.penaltyRiskTry, 0))} TL
          </b>
        </div>
      </>
    );
  }

  if (payload.tool === "get_bank_balance") {
    const rows = payload.data as { bank: string; currency: string; available: number; blocked: number }[];
    return (
      <>
        {rows.map((r, i) => (
          <div className="kv" key={i}>
            <span>
              {r.bank} · {r.currency}
            </span>
            <b>
              {tl(r.available)}
              {r.blocked > 0 && (
                <span style={{ color: "var(--warn)", fontWeight: 500 }}> (+{tl(r.blocked)} blokeli)</span>
              )}
            </b>
          </div>
        ))}
      </>
    );
  }

  if (payload.tool === "get_overtime") {
    const rows = payload.data as {
      employeeName: string;
      department: string;
      weekdayMinutes: number;
      weekendMinutes: number;
      pendingApprovalMinutes: number;
      grossSalaryTry: unknown;
    }[];
    return (
      <>
        {rows.map((r, i) => {
          const total = r.weekdayMinutes + r.weekendMinutes;
          return (
            <div className="rrow" key={i}>
              <div className="rmain">
                <div className="n">{r.employeeName}</div>
                <div className="s">
                  {r.department} · brüt ücret:{" "}
                  {typeof r.grossSalaryTry === "number" ? tl(r.grossSalaryTry) : String(r.grossSalaryTry)}
                </div>
              </div>
              <div className="rval">
                {Math.floor(total / 60)} sa {total % 60} dk
              </div>
            </div>
          );
        })}
      </>
    );
  }

  if (payload.tool === "match_invoice") {
    const m = payload.data as {
      status: string;
      totalVariance: number;
      invoiceTotal: number;
      confidence: number;
      findings: { lineNo: number; message: string; impact: number }[];
    } | null;
    if (!m) return <p>Fatura bulunamadı.</p>;
    return (
      <>
        <div className="kv">
          <span>Durum</span>
          <b style={{ color: m.status === "blocked" ? "var(--crit)" : "var(--ok)" }}>
            {m.status === "blocked" ? "Bloklandı" : "Eşleşti"}
          </b>
        </div>
        <div className="kv">
          <span>Fatura toplamı</span>
          <b>{tl(m.invoiceTotal)}</b>
        </div>
        <div className="kv">
          <span>Sapma</span>
          <b style={{ color: m.totalVariance !== 0 ? "var(--crit)" : undefined }}>{tl(m.totalVariance)}</b>
        </div>
        <div className="kv">
          <span>Güven skoru</span>
          <b>{m.confidence}/100</b>
        </div>
        {m.findings.map((f, i) => (
          <div className="risk" key={i}>
            <b>Kalem {f.lineNo}</b>
            <span>{f.message}</span>
          </div>
        ))}
      </>
    );
  }

  return <pre className="raw">{JSON.stringify(payload.data, null, 2)}</pre>;
}
