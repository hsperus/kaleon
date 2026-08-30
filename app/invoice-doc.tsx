"use client";

/**
 * Fatura belgesi.
 *
 * TABLO DEĞİL, FATURADIR. Tablo belgesi (bkz. `TableBody`) satır ve
 * sütundan ibarettir; fatura ise yasal olarak taşımak zorunda olduğu
 * unsurları taşır: iki tarafın unvanı, vergi numarası ve vergi
 * dairesi, kalem kırılımı, KDV'nin ORAN ORAN dökümü, toplamlar ve
 * tutarın yazıyla hâli. Bunlardan biri eksikse belge fatura değildir.
 *
 * EKSİK ALAN GİZLENMEZ, İŞARETLENİR. Vergi numarası olmayan bir
 * alıcıyı boş bırakıp geçmek, faturayı basan kişiye "her şey yolunda"
 * demektir; oysa o fatura e-Fatura olarak üretilemez. Eksik olan yerde
 * eksik olduğu yazar.
 */

import type { InvoiceView } from "../src/db/einvoice-repository.js";
import type { ExportSheet } from "./document.js";

const money = (n: number, currency: string): string =>
  new Intl.NumberFormat("tr-TR", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  }).format(n);

const qty = new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 3 });
const plain2 = new Intl.NumberFormat("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const STATUS: Record<string, string> = {
  draft: "TASLAK — kesilmemiş",
  issued: "Kesilmiş",
  cancelled: "İPTAL",
  paid: "Kesilmiş · tahsil edildi",
};

function date(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : new Intl.DateTimeFormat("tr-TR", { day: "2-digit", month: "2-digit", year: "numeric" }).format(d);
}

/** Bir tarafın adres bloğu. */
function PartyBlock({
  label,
  party,
}: {
  label: string;
  party: InvoiceView["customer"] | null;
}) {
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
        {/* VKN eksikse bu fatura e-Fatura olarak üretilemez; sessizce
            boş bırakmak yerine söylenir. */}
        VKN/TCKN: {party.taxId ?? <span className="inv-missing">eksik</span>}
        {party.taxOffice ? ` · ${party.taxOffice}` : ""}
      </div>
      {party.email && <div className="inv-party-line">{party.email}</div>}
    </div>
  );
}

export function InvoiceBody({ inv }: { inv: InvoiceView }) {
  const cur = inv.currency;
  return (
    <>
      <div className="inv-top">
        <h1 className="doc-title">Satış Faturası</h1>
        <dl className="inv-facts">
          <div>
            <dt>Fatura No</dt>
            <dd>{inv.documentNo}</dd>
          </div>
          <div>
            <dt>Düzenleme Tarihi</dt>
            <dd>{date(inv.issuedAt)}</dd>
          </div>
          <div>
            <dt>Durum</dt>
            <dd className={inv.status === "issued" || inv.status === "paid" ? "" : "inv-flag"}>
              {STATUS[inv.status] ?? inv.status}
            </dd>
          </div>
          {inv.ettn && (
            <div>
              <dt>ETTN</dt>
              <dd className="inv-mono">{inv.ettn}</dd>
            </div>
          )}
          {inv.einvoiceKind && (
            <div>
              <dt>Belge Türü</dt>
              <dd>{inv.einvoiceKind === "e-fatura" ? "e-Fatura" : "e-Arşiv"}</dd>
            </div>
          )}
          {inv.exchangeRate !== null && (
            <div>
              <dt>Kur</dt>
              <dd>
                1 {cur} = {plain2.format(inv.exchangeRate)} TRY
              </dd>
            </div>
          )}
        </dl>
      </div>

      <div className="inv-parties">
        <PartyBlock label="Satıcı" party={inv.supplier} />
        <PartyBlock label="Alıcı" party={inv.customer} />
      </div>

      <table className="doc-table inv-lines">
        <thead>
          <tr>
            <th className="num">#</th>
            <th>Açıklama</th>
            <th className="num">Miktar</th>
            <th>Birim</th>
            <th className="num">Birim Fiyat</th>
            <th className="num">İsk. %</th>
            <th className="num">Net Tutar</th>
            <th className="num">KDV %</th>
            <th className="num">KDV</th>
          </tr>
        </thead>
        <tbody>
          {inv.lines.map((l) => (
            <tr key={l.lineNo}>
              <td className="num">{l.lineNo}</td>
              <td>{l.description}</td>
              <td className="num">{qty.format(l.quantity)}</td>
              <td>{l.uom}</td>
              <td className="num">{plain2.format(l.unitPrice)}</td>
              <td className="num">{l.discountPercent > 0 ? plain2.format(l.discountPercent) : "—"}</td>
              <td className="num">{plain2.format(l.netAmount)}</td>
              <td className="num">{l.vatRate}</td>
              <td className="num">{plain2.format(l.vatAmount)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="inv-summary">
        {/* KDV ORAN ORAN gösterilir: iki oranlı bir faturada tek toplam,
            alıcının indirim yapmasını imkânsız kılar. */}
        <table className="inv-vat">
          <thead>
            <tr>
              <th>KDV Oranı</th>
              <th className="num">Matrah</th>
              <th className="num">KDV Tutarı</th>
            </tr>
          </thead>
          <tbody>
            {inv.vatBreakdown.map((v) => (
              <tr key={v.rate}>
                <td>%{v.rate}</td>
                <td className="num">{plain2.format(v.base)}</td>
                <td className="num">{plain2.format(v.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <dl className="inv-totals">
          <div>
            <dt>Mal/Hizmet Toplamı</dt>
            <dd>{money(inv.netAmount + inv.discountAmount, cur)}</dd>
          </div>
          {inv.discountAmount > 0 && (
            <div>
              <dt>İskonto</dt>
              <dd>−{money(inv.discountAmount, cur)}</dd>
            </div>
          )}
          <div>
            <dt>Vergi Matrahı</dt>
            <dd>{money(inv.netAmount, cur)}</dd>
          </div>
          <div>
            <dt>Hesaplanan KDV</dt>
            <dd>{money(inv.vatAmount, cur)}</dd>
          </div>
          <div className="inv-grand">
            <dt>Ödenecek Tutar</dt>
            <dd>{money(inv.totalAmount, cur)}</dd>
          </div>
        </dl>
      </div>

      <p className="inv-words">
        Yalnız: <b>{inv.totalInWords}</b>
      </p>
    </>
  );
}

/**
 * Faturanın Excel yükü.
 *
 * Kalemler ve KDV kırılımı AYRI SAYFALARDA. Tek sayfada alt alta
 * konsaydı, kalem sütunlarıyla KDV sütunları çakışır ve dosya
 * süzülemez hâle gelirdi.
 */
export function invoiceSheets(inv: InvoiceView): readonly ExportSheet[] {
  return [
    {
      name: "Kalemler",
      head: ["#", "Açıklama", "Miktar", "Birim", "Birim Fiyat", "İsk. %", "Net Tutar", "KDV %", "KDV"],
      rows: inv.lines.map((l) => [
        String(l.lineNo),
        l.description,
        plain2.format(l.quantity),
        l.uom,
        plain2.format(l.unitPrice),
        plain2.format(l.discountPercent),
        plain2.format(l.netAmount),
        String(l.vatRate),
        plain2.format(l.vatAmount),
      ]),
      numeric: [true, false, true, false, true, true, true, true, true],
    },
    {
      name: "KDV Kırılımı",
      head: ["KDV Oranı", "Matrah", "KDV Tutarı"],
      rows: [
        ...inv.vatBreakdown.map((v) => [
          String(v.rate),
          plain2.format(v.base),
          plain2.format(v.amount),
        ]),
        ["Toplam", plain2.format(inv.netAmount), plain2.format(inv.vatAmount)],
      ],
      numeric: [true, true, true],
    },
  ];
}
