"use client";

/**
 * Sevk irsaliyesi belgesi.
 *
 * FATURA FORMU KULLANILMAZ. İrsaliyede tutar YOKTUR; mal bedeli
 * faturada beyan edilir ve irsaliyeye yazılan bir tutar fatura
 * tutarından saparsa denetimde açıklanması gereken bir çelişki
 * bırakır. Buna karşılık faturada bulunmayan alanlar taşır: taşıyıcı,
 * plaka, sürücü ve malın FİİLEN araca yüklendiği an — yol denetiminde
 * sorulan tam olarak bunlardır.
 */

import type { DespatchView } from "../src/db/einvoice-repository.js";
import type { ExportSheet } from "./document.js";

const qty = new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 3 });

const STATUS: Record<string, string> = {
  draft: "TASLAK — mal sevk edilmedi",
  posted: "Sevk edildi",
  cancelled: "İPTAL",
};

function dt(iso: string | null, withTime = false): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("tr-TR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}),
  }).format(d);
}

function PartyBlock({ label, party }: { label: string; party: DespatchView["customer"] | null }) {
  if (!party) {
    return (
      <div className="inv-party">
        <div className="inv-party-label">{label}</div>
        <div className="inv-missing">Tanımlı değil</div>
      </div>
    );
  }
  const address = [party.addressLine, [party.district, party.city].filter(Boolean).join(" / ")]
    .filter(Boolean)
    .join("\n");
  return (
    <div className="inv-party">
      <div className="inv-party-label">{label}</div>
      <div className="inv-party-name">{party.legalName}</div>
      {address && <div className="inv-party-line">{address}</div>}
      <div className="inv-party-line">
        VKN/TCKN: {party.taxId ?? <span className="inv-missing">eksik</span>}
        {party.taxOffice ? ` · ${party.taxOffice}` : ""}
      </div>
    </div>
  );
}

/** Eksikse kırmızı yazan alan — plakasız irsaliye yolda durdurulur. */
function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value ?? <span className="inv-missing">eksik</span>}</dd>
    </div>
  );
}

export function DespatchBody({ d }: { d: DespatchView }) {
  return (
    <>
      <div className="inv-top">
        <h1 className="doc-title">Sevk İrsaliyesi</h1>
        <dl className="inv-facts">
          <div>
            <dt>İrsaliye No</dt>
            <dd>{d.documentNo}</dd>
          </div>
          <div>
            <dt>Sevk Tarihi</dt>
            <dd>{dt(d.shippedAt)}</dd>
          </div>
          <div>
            <dt>Durum</dt>
            <dd className={d.status === "posted" ? "" : "inv-flag"}>
              {STATUS[d.status] ?? d.status}
            </dd>
          </div>
          {d.orderNo && (
            <div>
              <dt>Sipariş</dt>
              <dd>{d.orderNo}</dd>
            </div>
          )}
          {d.ettn && (
            <div>
              <dt>ETTN</dt>
              <dd className="inv-mono">{d.ettn}</dd>
            </div>
          )}
        </dl>
      </div>

      <div className="inv-parties">
        <PartyBlock label="Gönderen" party={d.supplier} />
        <PartyBlock label="Alıcı" party={d.customer} />
      </div>

      {/* TAŞIMA BİLGİSİ İRSALİYENİN ASIL İÇERİĞİDİR: yol denetiminde
          bakılan yer burasıdır ve eksik alan gizlenmez. */}
      <dl className="dsp-transport">
        <Field label="Taşıyıcı" value={d.carrierName} />
        <Field label="Plaka" value={d.plateNo} />
        <Field label="Sürücü" value={d.driverName} />
        <Field label="Çıkış Deposu" value={d.location} />
        <Field
          label="Fiili Sevk Zamanı"
          value={d.actualDespatchAt ? dt(d.actualDespatchAt, true) : null}
        />
      </dl>

      <table className="doc-table inv-lines">
        <thead>
          <tr>
            <th className="num">#</th>
            <th>Malın Cinsi</th>
            <th>Kod</th>
            <th className="num">Miktar</th>
            <th>Birim</th>
            <th>Parti/Seri</th>
          </tr>
        </thead>
        <tbody>
          {d.lines.map((l) => (
            <tr key={l.lineNo}>
              <td className="num">{l.lineNo}</td>
              <td>{l.description}</td>
              <td>{l.itemId}</td>
              <td className="num">{qty.format(l.quantity)}</td>
              <td>{l.uom}</td>
              <td>{l.batchId ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Tutar bilerek yok; imza satırı irsaliyenin teamülüdür. */}
      <div className="dsp-signs">
        <div>
          <span />
          Teslim Eden
        </div>
        <div>
          <span />
          Teslim Alan
        </div>
      </div>
    </>
  );
}

export function despatchSheets(d: DespatchView): readonly ExportSheet[] {
  return [
    {
      name: "Sevk Kalemleri",
      head: ["#", "Malın Cinsi", "Kod", "Miktar", "Birim", "Parti/Seri"],
      rows: d.lines.map((l) => [
        String(l.lineNo),
        l.description,
        l.itemId,
        qty.format(l.quantity),
        l.uom,
        l.batchId ?? "",
      ]),
      numeric: [true, false, false, true, false, false],
    },
  ];
}
