"use client";

/**
 * Cari mutabakat mektubu.
 *
 * TÜRKİYE'DE MUTABAKAT BİR RİTÜELDİR. Dönem sonlarında her işletme
 * carilerine ekstre gönderir, karşı taraf imzalar ve geri yollar;
 * uyuşmazlık varsa hangi belgede olduğu bu kâğıt üzerinde bulunur.
 * Ba/Bs formları 2024'te kaldırıldıktan sonra karşılıklı doğrulamanın
 * kalan yolu da budur.
 *
 * YÜRÜYEN BAKİYE SATIR SATIR GÖRÜNÜR. Yalnızca son bakiye yazan bir
 * mektup mutabakat sağlamaz: "bu rakam nereden geldi" sorusunun
 * cevabı olmadan karşı taraf imzalayamaz.
 */

import { amountInWords } from "../src/modules/einvoice/invoice-view.js";
import type { ExportSheet } from "./document.js";

export interface StatementMovement {
  readonly date: string;
  readonly documentNo: string;
  readonly description: string;
  readonly accountCode: string;
  readonly debit: number;
  readonly credit: number;
  readonly balance: number;
}

export interface StatementView {
  readonly kind: "statement";
  readonly from: string;
  readonly to: string;
  readonly partnerId: string;
  readonly partnerName: string;
  readonly partnerCode: string | null;
  readonly partnerAddress: string | null;
  readonly partnerTaxOffice: string | null;
  readonly openingBalance: number;
  readonly closingBalance: number;
  readonly movements: readonly StatementMovement[];
}

const money = new Intl.NumberFormat("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function date(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : new Intl.DateTimeFormat("tr-TR", { day: "2-digit", month: "2-digit", year: "numeric" }).format(d);
}

/** Bakiyenin yönü: borçlu mu alacaklı mı. */
function side(balance: number): string {
  if (balance > 0) return "BORÇ";
  if (balance < 0) return "ALACAK";
  return "SIFIR";
}

export function StatementBody({ s }: { s: StatementView }) {
  const abs = Math.abs(s.closingBalance);
  return (
    <>
      <div className="inv-top">
        <h1 className="doc-title">Cari Hesap Mutabakat Mektubu</h1>
        <dl className="inv-facts">
          <div>
            <dt>Dönem</dt>
            <dd>
              {date(s.from)} — {date(s.to)}
            </dd>
          </div>
          {s.partnerCode && (
            <div>
              <dt>Cari Kodu</dt>
              <dd>{s.partnerCode}</dd>
            </div>
          )}
          <div>
            <dt>Hareket</dt>
            <dd>{s.movements.length}</dd>
          </div>
        </dl>
      </div>

      <div className="inv-parties">
        <div className="inv-party">
          <div className="inv-party-label">Sayın</div>
          <div className="inv-party-name">{s.partnerName}</div>
          {s.partnerAddress && <div className="inv-party-line">{s.partnerAddress}</div>}
          {s.partnerTaxOffice && (
            <div className="inv-party-line">Vergi Dairesi: {s.partnerTaxOffice}</div>
          )}
        </div>
        <div className="inv-party">
          <div className="inv-party-label">Dönem Sonu Bakiye</div>
          <div className="st-closing">
            {money.format(abs)} <span>{side(s.closingBalance)}</span>
          </div>
          <div className="inv-party-line">
            Açılış bakiyesi: {money.format(Math.abs(s.openingBalance))}{" "}
            {side(s.openingBalance)}
          </div>
        </div>
      </div>

      {s.movements.length === 0 ? (
        <p className="bs-empty">Bu dönemde hareket yok.</p>
      ) : (
        <table className="doc-table inv-lines">
          <thead>
            <tr>
              <th>Tarih</th>
              <th>Belge</th>
              <th>Açıklama</th>
              <th className="num">Borç</th>
              <th className="num">Alacak</th>
              <th className="num">Bakiye</th>
            </tr>
          </thead>
          <tbody>
            {s.movements.map((m, i) => (
              <tr key={`${m.documentNo}-${i}`}>
                <td>{date(m.date)}</td>
                <td>{m.documentNo}</td>
                <td>{m.description}</td>
                <td className="num">{m.debit > 0 ? money.format(m.debit) : "—"}</td>
                <td className="num">{m.credit > 0 ? money.format(m.credit) : "—"}</td>
                <td className="num">{money.format(m.balance)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p className="inv-words">
        Yukarıdaki dönem sonu bakiyesi <b>{amountInWords(abs, "TRY")}</b> (
        {side(s.closingBalance)}) olarak görünmektedir. Kayıtlarınızla mutabık iseniz
        mektubu imzalayıp tarafımıza iletmenizi, mutabık değilseniz farkın hangi belgeden
        kaynaklandığını bildirmenizi rica ederiz.
      </p>

      {/* İMZA BLOĞU MEKTUBUN İŞLEVİDİR. Karşı taraf imzalayıp geri
          gönderdiğinde mutabakat tamamlanmış olur. */}
      <div className="dsp-signs">
        <div>
          <span />
          Düzenleyen
        </div>
        <div>
          <span />
          Mutabıkız / Mutabık Değiliz (Kaşe — İmza)
        </div>
      </div>
    </>
  );
}

export function statementSheets(s: StatementView): readonly ExportSheet[] {
  return [
    {
      name: "Ekstre",
      head: ["Tarih", "Belge", "Açıklama", "Hesap", "Borç", "Alacak", "Bakiye"],
      rows: [
        ["", "", "Açılış bakiyesi", "", "", "", money.format(s.openingBalance)],
        ...s.movements.map((m) => [
          m.date.slice(0, 10),
          m.documentNo,
          m.description,
          m.accountCode,
          m.debit > 0 ? money.format(m.debit) : "",
          m.credit > 0 ? money.format(m.credit) : "",
          money.format(m.balance),
        ]),
        ["", "", "Dönem sonu bakiye", "", "", "", money.format(s.closingBalance)],
      ],
      numeric: [false, false, false, false, true, true, true],
    },
  ];
}
