"use client";

/**
 * Bilanço belgesi.
 *
 * TABLO DEĞİL, İKİ SÜTUNLU FORM. Türk bilançosu aktifi solda, pasifi
 * sağda gösterir ve iki tarafın toplamı EN ALTTA yan yana durur;
 * bakan kişi denk olup olmadığını tek bakışta görür. Tek sütunlu bir
 * liste teknik olarak aynı bilgiyi taşır ama bilanço okumayı bilen
 * hiç kimse onu bilanço saymaz.
 *
 * DENK DEĞİLSE BELGENİN ÜSTÜNDE YAZAR. Denksiz bir bilanço bankaya
 * götürülmemeli; sessizce basılırsa tam olarak bu olur.
 */

import type { ExportSheet } from "./document.js";

export interface BalanceGroupView {
  readonly code: string;
  readonly label: string;
  readonly amount: number;
  readonly lines: readonly { code: string; name: string; amount: number }[];
}

export interface BalanceSheetView {
  readonly kind: "balance-sheet";
  readonly asOf: string;
  readonly periodFrom: string;
  readonly assets: readonly BalanceGroupView[];
  readonly liabilities: readonly BalanceGroupView[];
  readonly totalAssets: number;
  readonly totalLiabilities: number;
  readonly periodResult: number;
  readonly balanced: boolean;
  readonly difference: number;
}

const money = new Intl.NumberFormat("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function date(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : new Intl.DateTimeFormat("tr-TR", { day: "2-digit", month: "long", year: "numeric" }).format(d);
}

function Side({ title, groups, total }: { title: string; groups: readonly BalanceGroupView[]; total: number }) {
  return (
    <div className="bs-side">
      <h2 className="bs-side-title">{title}</h2>
      {groups.length === 0 ? (
        <p className="bs-empty">Bu tarafta kayıt yok.</p>
      ) : (
        groups.map((g) => (
          <div className="bs-group" key={g.code + g.label}>
            <div className="bs-group-head">
              <span>
                <b>{g.code}.</b> {g.label}
              </span>
              <span className="num">{money.format(g.amount)}</span>
            </div>
            {/* Hesap kodları görünür kalır: mali müşavir tabloyu koda
                göre okur, başlığa göre değil. */}
            {g.lines.map((l) => (
              <div className="bs-line" key={l.code}>
                <span>
                  <i>{l.code}</i> {l.name}
                </span>
                <span className="num">{money.format(l.amount)}</span>
              </div>
            ))}
          </div>
        ))
      )}
      <div className="bs-total">
        <span>{title} Toplamı</span>
        <span className="num">{money.format(total)}</span>
      </div>
    </div>
  );
}

export function BalanceSheetBody({ b }: { b: BalanceSheetView }) {
  return (
    <>
      <div className="inv-top">
        <h1 className="doc-title">Bilanço</h1>
        <dl className="inv-facts">
          <div>
            <dt>Tarih İtibarıyla</dt>
            <dd>{date(b.asOf)}</dd>
          </div>
          <div>
            <dt>Dönem Başı</dt>
            <dd>{date(b.periodFrom)}</dd>
          </div>
          <div>
            <dt>Durum</dt>
            <dd className={b.balanced ? "" : "inv-flag"}>{b.balanced ? "Denk" : "DENK DEĞİL"}</dd>
          </div>
        </dl>
      </div>

      {!b.balanced && (
        <p className="bs-warn">
          Aktif ile pasif arasında <b>{money.format(b.difference)}</b> fark var. Bu tablo
          kullanılmamalıdır; yevmiye kayıtlarında tek taraflı bir kayıt bulunmalıdır.
        </p>
      )}

      <div className="bs-grid">
        <Side title="AKTİF (Varlıklar)" groups={b.assets} total={b.totalAssets} />
        <Side title="PASİF (Kaynaklar)" groups={b.liabilities} total={b.totalLiabilities} />
      </div>

      <p className="inv-words">
        Dönem sonucu: <b>{money.format(b.periodResult)}</b>{" "}
        {b.periodResult >= 0 ? "kâr" : "zarar"} — özkaynak içinde gösterilmiştir.
      </p>
    </>
  );
}

/** Bilançonun Excel yükü: aktif ve pasif ayrı sayfalarda. */
export function balanceSheets(b: BalanceSheetView): readonly ExportSheet[] {
  const side = (groups: readonly BalanceGroupView[]): (readonly string[])[] =>
    groups.flatMap((g) => [
      [g.code, g.label, "", money.format(g.amount)],
      ...g.lines.map((l) => ["", "", `${l.code} ${l.name}`, money.format(l.amount)]),
    ]);

  return [
    {
      name: "Aktif",
      head: ["Grup", "Başlık", "Hesap", "Tutar"],
      rows: [...side(b.assets), ["", "AKTİF TOPLAMI", "", money.format(b.totalAssets)]],
      numeric: [false, false, false, true],
    },
    {
      name: "Pasif",
      head: ["Grup", "Başlık", "Hesap", "Tutar"],
      rows: [...side(b.liabilities), ["", "PASİF TOPLAMI", "", money.format(b.totalLiabilities)]],
      numeric: [false, false, false, true],
    },
  ];
}
