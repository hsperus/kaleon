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
import type { Letterhead } from "../src/modules/documents/letterhead.js";
import {
  DocumentSheet,
  FileCard,
  dosyaAdi,
  istenenBicim,
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
  letterhead = null,
  question = "",
}: {
  text: string;
  animate?: boolean;
  /** Dosya adında ve antet yokken kullanılan kısa ad. */
  org?: string;
  /** Şirketin hukuki kimliği — belgenin antedi. */
  letterhead?: Letterhead | null;
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
              meta={{ title: titleFor(blocks, i, question), org, question, letterhead }}
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
/**
 * Sorudan belge başlığı.
 *
 * SÜTUN ADI KÖTÜ BİR BAŞLIKTIR. Cevapta başlık yoksa eskiden ilk
 * sütunun adı kullanılıyordu: "çalışan listesini excel yap" sorusunun
 * ürettiği dosya "Kod listesi.xlsx" oluyordu. Soru zaten kullanıcının
 * kendi ifadesi — belgeye onun adını vermek hem doğru hem tanıdık.
 *
 * BİÇİM VE EYLEM KELİMELERİ ATILIR: "excel dosyası olarak hazırla"
 * belgenin adı değil, onu isteme biçimidir.
 */
export function titleFromQuestion(question: string): string | null {
  /*
   * KELİME KELİME ELENİR, REGEX'LE DEĞİL.
   *
   * İlk yazımda `\b(excel|dosyası|...)\b` kullanmıştım ve Türkçede
   * çalışmadı: JavaScript'te "ı", "ş", "ğ" sözcük karakteri sayılmaz,
   * dolayısıyla `\b` bu harflerin çevresinde yanlış eşleşir.
   * "dosyası" elenmiyor, "Çalışan listesini dosyası" gibi bir başlık
   * çıkıyordu.
   *
   * Kelimeleri ayırıp listeyle karşılaştırmak hem doğru hem okunur.
   */
  const ATILACAK = new Set([
    "excel", "word", "pdf", "dosya", "dosyası", "dosyasını", "dosyasi",
    "olarak", "halinde", "hâlinde", "biçiminde", "formatında",
    "hazırla", "hazırlar", "oluştur", "çıkar", "çıkart", "ver", "getir",
    "listele", "göster", "yap", "indir", "kaydet", "aktar",
    // "bu" ve "şu" ATILMAZ: "bu ayki bordro" ile "ayki bordro" aynı
    // şey değil. Anlam taşıyan kelime, gürültü değildir.
    "lütfen", "bana", "bir",
  ]);

  const kelimeler = question
    .replace(/[?!.,;:]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((k) => !ATILACAK.has(k.toLocaleLowerCase("tr")));

  if (kelimeler.length === 0) return null;

  /*
   * Belirtme eki başlıkta kulağı tırmalar: "listesini" → "listesi",
   * "bilançoyu" → "bilanço".
   *
   * YALNIZCA GÜVENLİ İKİ KALIP. Ünsüzden sonra gelen -ı/-i/-u/-ü de
   * belirtme ekidir ama iyelik ekiyle aynı görünür: "kârı" hem
   * "kâr-ı" hem "onun kârı" olabilir. Ayırt edemediğimiz yerde
   * dokunmuyoruz — yanlış kesilmiş bir kelime, ekli hâlinden kötüdür.
   */
  const son = kelimeler.length - 1;
  kelimeler[son] = kelimeler[son]!
    .replace(/(si|sı|su|sü)n[ıiuü]$/i, "$1")
    .replace(/y[ıiuü]$/i, "");

  const t = kelimeler.join(" ").trim();
  if (t.length < 3) return null;

  const baslik = t.charAt(0).toLocaleUpperCase("tr") + t.slice(1);
  return baslik.length > 60 ? `${baslik.slice(0, 60).trimEnd()}…` : baslik;
}

export function titleFor(blocks: readonly Block[], index: number, question = ""): string {
  for (let k = index - 1; k >= 0; k -= 1) {
    const b = blocks[k]!;
    if (b.kind === "heading") return b.text.replace(/\*\*/g, "").trim();
    // Araya paragraf girmesi başlığı geçersiz kılmaz; başka bir tablo kılar.
    if (b.kind === "table") break;
  }
  // Başlık yoksa SORU kullanılır; sütun adı ancak son çare.
  const sorudan = titleFromQuestion(question);
  if (sorudan) return sorudan;
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
  const bicim = istenenBicim(meta.question);

  return (
    <figure className="md-table-fig">
      {/* Biçim SORUDAN gelir: "excel yap" diyen kişiye Word düğmesi
          göstermek, cevabı bir menüye çevirir. */}
      <FileCard
        fileName={dosyaAdi(meta.org, meta.title, bicim === "pdf" ? "pdf" : bicim)}
        format={bicim}
        rowCount={table.rows.length}
        busy={busy}
        onOpen={() => onOpen({ meta, table: doc, block: table })}
        onDownload={() => {
          // PDF tarayıcının yazdırma akışıyla üretilir; belge görünümü
          // açılır ve yazdırma biçemi orada devreye girer.
          if (bicim === "pdf") {
            onOpen({ meta, table: doc, block: table });
            return;
          }
          setBusy(true);
          setErr(null);
          void downloadFile(
            meta.title,
            [sheetFromTable(meta.title, doc)],
            bicim,
            dosyaAdi(meta.org, meta.title, bicim),
          )
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
