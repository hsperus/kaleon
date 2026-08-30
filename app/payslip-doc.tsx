"use client";

/**
 * Bordro pusulası.
 *
 * PUSULA ÇALIŞANA VERİLİR VE ÇALIŞAN ONU KONTROL EDER. Bu yüzden
 * yalnızca net tutarı yazmak yetmez: kesintilerin her biri, matrahı ve
 * hangi orandan hesaplandığı görünmelidir. Anlaşılmayan bir kesinti,
 * İK'ya sorulan bir soru ve güvensizlik demektir.
 *
 * KÜMÜLATİF MATRAH DA YAZAR. Çalışanın "geçen ay daha çok almıştım"
 * sorusunun cevabı budur: dilim atlamıştır ve pusulada bunu görebilir.
 */

import { amountInWords } from "../src/modules/einvoice/invoice-view.js";
import type { ExportSheet } from "./document.js";

export interface PayslipView {
  readonly kind: "payslip";
  readonly employeeCode: string;
  readonly employeeName: string;
  readonly department: string;
  readonly position: string;
  readonly period: string;
  readonly grossSalary: number;
  readonly bonus: number;
  readonly totalGross: number;
  readonly sgkBase: number;
  readonly employeeSgk: number;
  readonly employeeUnemployment: number;
  readonly taxBase: number;
  readonly cumulativeBefore: number;
  readonly cumulativeAfter: number;
  readonly grossIncomeTax: number;
  readonly incomeTaxExemption: number;
  readonly incomeTax: number;
  readonly stampDuty: number;
  readonly totalDeductions: number;
  readonly netSalary: number;
  readonly employerSgk: number;
  readonly employerUnemployment: number;
  readonly employerCost: number;
}

const money = new Intl.NumberFormat("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const MONTHS = [
  "Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran",
  "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık",
];

function periodLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function Row({
  label,
  value,
  note,
  strong,
}: {
  label: string;
  value: number;
  note?: string | undefined;
  strong?: boolean | undefined;
}) {
  return (
    <div className={`ps-row${strong ? " strong" : ""}`}>
      <span className="ps-label">
        {label}
        {note && <i>{note}</i>}
      </span>
      <span className="num">{money.format(value)}</span>
    </div>
  );
}

export function PayslipBody({ p }: { p: PayslipView }) {
  return (
    <>
      <div className="inv-top">
        <h1 className="doc-title">Ücret Bordrosu</h1>
        <dl className="inv-facts">
          <div>
            <dt>Dönem</dt>
            <dd>{periodLabel(p.period)}</dd>
          </div>
          <div>
            <dt>Sicil No</dt>
            <dd>{p.employeeCode}</dd>
          </div>
        </dl>
      </div>

      <div className="inv-parties">
        <div className="inv-party">
          <div className="inv-party-label">Çalışan</div>
          <div className="inv-party-name">{p.employeeName}</div>
          <div className="inv-party-line">
            {p.department} · {p.position}
          </div>
        </div>
        <div className="inv-party">
          <div className="inv-party-label">Net Ödenecek</div>
          <div className="st-closing">{money.format(p.netSalary)}</div>
        </div>
      </div>

      <div className="ps-grid">
        <section>
          <h2 className="bs-side-title">KAZANÇLAR</h2>
          <Row label="Brüt ücret" value={p.grossSalary} />
          {p.bonus > 0 && <Row label="Prim / ikramiye" value={p.bonus} />}
          <Row label="Toplam brüt" value={p.totalGross} strong />
          {/* SGK matrahı brütten FARKLI olabilir: taban ve tavan
              uygulanır ve çalışan bunu pusulada görmelidir. */}
          <Row
            label="SGK matrahı"
            value={p.sgkBase}
            note={p.sgkBase !== p.totalGross ? "taban/tavan uygulandı" : undefined}
          />
        </section>

        <section>
          <h2 className="bs-side-title">KESİNTİLER</h2>
          <Row label="SGK primi" value={p.employeeSgk} note="%14" />
          <Row label="İşsizlik sigortası" value={p.employeeUnemployment} note="%1" />
          <Row label="Gelir vergisi matrahı" value={p.taxBase} />
          <Row label="Hesaplanan gelir vergisi" value={p.grossIncomeTax} />
          {/* İSTİSNA AYRI SATIRDIR. Netleştirilmiş bir vergi rakamı,
              çalışanın istisnadan yararlandığını gizlerdi. */}
          <Row
            label="Asgari ücret istisnası"
            value={-p.incomeTaxExemption}
            note="gelir vergisi"
          />
          <Row label="Gelir vergisi" value={p.incomeTax} strong />
          <Row label="Damga vergisi" value={p.stampDuty} note="binde 7,59" />
          <Row label="Toplam kesinti" value={p.totalDeductions} strong />
        </section>
      </div>

      <div className="ps-net">
        <span>NET ÖDENECEK</span>
        <span className="num">{money.format(p.netSalary)}</span>
      </div>

      <p className="inv-words">
        Yalnız <b>{amountInWords(p.netSalary, "TRY")}</b>.
      </p>

      {/* KÜMÜLATİF MATRAH PUSULADA DURUR: "geçen ay daha çok almıştım"
          sorusunun cevabı budur. */}
      <dl className="dsp-transport">
        <div>
          <dt>Önceki Kümülatif Matrah</dt>
          <dd>{money.format(p.cumulativeBefore)}</dd>
        </div>
        <div>
          <dt>Bu Ay Sonrası</dt>
          <dd>{money.format(p.cumulativeAfter)}</dd>
        </div>
        <div>
          <dt>İşveren SGK Payı</dt>
          <dd>{money.format(p.employerSgk + p.employerUnemployment)}</dd>
        </div>
        <div>
          <dt>İşverene Toplam Maliyet</dt>
          <dd>{money.format(p.employerCost)}</dd>
        </div>
      </dl>

      <div className="dsp-signs">
        <div>
          <span />
          İşveren / Vekili
        </div>
        <div>
          <span />
          Çalışan (Teslim Aldım)
        </div>
      </div>
    </>
  );
}

export function payslipSheets(p: PayslipView): readonly ExportSheet[] {
  return [
    {
      name: "Bordro",
      head: ["Kalem", "Tutar"],
      rows: [
        ["Brüt ücret", money.format(p.grossSalary)],
        ["Prim / ikramiye", money.format(p.bonus)],
        ["Toplam brüt", money.format(p.totalGross)],
        ["SGK matrahı", money.format(p.sgkBase)],
        ["SGK primi (%14)", money.format(p.employeeSgk)],
        ["İşsizlik sigortası (%1)", money.format(p.employeeUnemployment)],
        ["Gelir vergisi matrahı", money.format(p.taxBase)],
        ["Hesaplanan gelir vergisi", money.format(p.grossIncomeTax)],
        ["Asgari ücret istisnası", money.format(-p.incomeTaxExemption)],
        ["Gelir vergisi", money.format(p.incomeTax)],
        ["Damga vergisi", money.format(p.stampDuty)],
        ["Toplam kesinti", money.format(p.totalDeductions)],
        ["NET ÖDENECEK", money.format(p.netSalary)],
        ["İşveren SGK payı", money.format(p.employerSgk + p.employerUnemployment)],
        ["İşverene toplam maliyet", money.format(p.employerCost)],
      ],
      numeric: [false, true],
    },
  ];
}
