"use client";

/**
 * Zengin cevap render'ı.
 *
 * MODEL MARKDOWN YAZIYOR, EKRAN DÜZ METİN GÖSTERİYORDU. Cevapta
 * `**25.200.000 TL**` yazdığında kullanıcı yıldızları olduğu gibi
 * görüyordu; tablo istendiğinde boru işaretleriyle dolu bir yığın.
 *
 * KELİME ANİMASYONU SAYFA GENELİNDE SIRALIDIR. Her blok kendi başına
 * sıfırdan başlasaydı, tablodan sonraki paragraf tablodan önce belirir
 * ve göz metnin sırasını kaybederdi.
 */

import { Fragment, useState } from "react";
import { parseBlocks, parseInline, type Block, type InlineToken } from "../src/ui/markdown.js";
import { ChartPanel } from "./chart-panel.js";
import {
  DocumentSheet,
  TableActions,
  TableBody,
  downloadFile,
  sheetFromTable,
  type DocMeta,
  type DocTable,
} from "./document.js";

/** Animasyon sayacını taşıyan sıra numarası üreteci. */
function makeCounter(): { next(): number } {
  let n = 0;
  return {
    next() {
      const v = Math.min(n * 0.012, 1.2);
      n += 1;
      return v;
    },
  };
}

function Word({ text, delay }: { text: string; delay: number }) {
  return (
    <span className="w" style={{ animationDelay: `${delay}s` }}>
      {text}
    </span>
  );
}

/** Bir satır içi diziyi kelime kelime belirerek basar. */
function Inline({
  tokens,
  counter,
  animate,
}: {
  tokens: readonly InlineToken[];
  counter: { next(): number };
  animate: boolean;
}) {
  return (
    <>
      {tokens.map((t, i) => {
        if (t.kind === "code") {
          return (
            <code className="md-code" key={i}>
              {t.value}
            </code>
          );
        }

        const words = t.value.split(/(\s+)/);
        const body = words.map((w, j) => {
          if (/^\s+$/.test(w) || w === "") return <Fragment key={j}>{w}</Fragment>;
          return animate ? <Word key={j} text={w} delay={counter.next()} /> : <Fragment key={j}>{w}</Fragment>;
        });

        if (t.kind === "bold") return <strong key={i}>{body}</strong>;
        if (t.kind === "italic") return <em key={i}>{body}</em>;
        return <Fragment key={i}>{body}</Fragment>;
      })}
    </>
  );
}

export function RichText({
  text,
  animate = true,
  org = "İşletme",
  question = "",
}: {
  text: string;
  animate?: boolean;
  /** Antette görünen şirket adı. */
  org?: string;
  /** Belgeyi doğuran soru — belgenin altında kaydı kalır. */
  question?: string;
}) {
  const blocks = parseBlocks(text);
  const counter = makeCounter();
  const [open, setOpen] = useState<{
    meta: DocMeta;
    table: DocTable;
    /** Grafik planı ham blok üzerinden çıkarılır. */
    block: Extract<Block, { kind: "table" }>;
  } | null>(null);

  return (
    <div className="txt md">
      {open && (
        <DocumentSheet
          meta={open.meta}
          sheets={[sheetFromTable(open.meta.title, open.table)]}
          chart={<ChartPanel table={open.block} title={open.meta.title} />}
          onClose={() => setOpen(null)}
        >
          <TableBody meta={open.meta} table={open.table} />
        </DocumentSheet>
      )}
      {blocks.map((b, i) => {
        if (b.kind === "heading") {
          const Tag = (`h${Math.min(b.level, 4)}` as unknown) as "h2";
          return (
            <Tag className="md-h" key={i}>
              <Inline tokens={parseInline(b.text)} counter={counter} animate={animate} />
            </Tag>
          );
        }

        if (b.kind === "code") {
          return (
            <pre className="md-pre" key={i}>
              <code>{b.text}</code>
            </pre>
          );
        }

        if (b.kind === "quote") {
          return (
            <blockquote className="md-quote" key={i}>
              <Inline tokens={parseInline(b.text)} counter={counter} animate={animate} />
            </blockquote>
          );
        }

        if (b.kind === "list") {
          const Tag = b.ordered ? "ol" : "ul";
          return (
            <Tag className="md-list" key={i}>
              {b.items.map((item, j) => (
                <li key={j}>
                  <Inline tokens={parseInline(item)} counter={counter} animate={animate} />
                </li>
              ))}
            </Tag>
          );
        }

        if (b.kind === "table") {
          return (
            <TableBlock
              key={i}
              table={b}
              meta={{ title: titleFor(blocks, i), org, question }}
              onOpen={setOpen}
            />
          );
        }

        return (
          <p className="md-p" key={i}>
            <Inline tokens={parseInline(b.text)} counter={counter} animate={animate} />
          </p>
        );
      })}
    </div>
  );
}

/**
 * Belge başlığı.
 *
 * Tablonun kendi başlığı yoktur; cevabın içinde en yakın üstteki
 * BAŞLIK onun adıdır. Bulunamazsa ilk sütun adı kullanılır —
 * "Tablo" gibi boş bir ad, indirilen dosyayı bir hafta sonra
 * tanınamaz yapar.
 */
export function titleFor(blocks: readonly Block[], index: number): string {
  for (let k = index - 1; k >= 0; k -= 1) {
    const b = blocks[k]!;
    if (b.kind === "heading") return b.text.replace(/\*\*/g, "").trim();
    // Araya paragraf girmesi başlığı geçersiz kılmaz; başka bir tablo kılar.
    if (b.kind === "table") break;
  }
  const t = blocks[index]!;
  if (t.kind === "table" && t.head[0]) return `${t.head[0]} listesi`;
  return "Rapor";
}

/** Sayfa akışındaki tablo: kendi eylem şeridiyle birlikte. */
function TableBlock({
  table,
  meta,
  onOpen,
}: {
  table: Extract<Block, { kind: "table" }>;
  meta: DocMeta;
  onOpen: (v: {
    meta: DocMeta;
    table: DocTable;
    block: Extract<Block, { kind: "table" }>;
  }) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const doc: DocTable = { head: table.head, rows: table.rows, numeric: table.numeric };
  const still = { next: () => 0 };

  return (
    <figure className="md-table-fig">
      <TableActions
        onOpen={() => onOpen({ meta, table: doc, block: table })}
        busy={busy}
        onExport={(format) => {
          setBusy(true);
          setErr(null);
          void downloadFile(meta.title, [sheetFromTable(meta.title, doc)], format)
            .then(setErr)
            .finally(() => setBusy(false));
        }}
      />
      <div className="md-table-wrap">
        <table className="md-table">
          <thead>
            <tr>
              {table.head.map((h, c) => (
                <th key={c} className={table.numeric[c] ? "num" : ""}>
                  {h.replace(/\*\*/g, "")}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((r, j) => (
              <tr key={j}>
                {r.map((cell, c) => (
                  <td key={c} className={table.numeric[c] ? "num" : ""}>
                    <Inline tokens={parseInline(cell)} counter={still} animate={false} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {err && <figcaption className="md-table-err">{err}</figcaption>}
    </figure>
  );
}
