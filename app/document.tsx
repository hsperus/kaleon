"use client";

/**
 * Belge katmanı.
 *
 * SOHBET CEVABI BELGE DEĞİLDİR. Bir mizan ya da cari ekstre, akış
 * içinde okunmak için yeterli olsa da imzalanmak, arşivlenmek ya da
 * bankaya verilmek için resmî bir forma ihtiyaç duyar. Buradaki katman
 * cevabın İÇİNDEKİ tabloyu alıp o forma sokar — veriyi yeniden
 * sormadan, yeni bir tool çağırmadan.
 *
 * PDF İÇİN KÜTÜPHANE YOK, BİLEREK. Tarayıcının kendi yazdırma motoru
 * hem yazı tiplerini hem Türkçe karakterleri doğru basar; gömülü bir
 * PDF üreticisi ise kendi font tablosunu taşımak zorunda kalır ve "ş"
 * ile "ğ" ilk müşteri belgesinde kutuya döner. Yazdırma biçemi
 * (`@media print`) belgeyi sayfadan ayırır: ekranda ne görünüyorsa
 * kâğıda o çıkar.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { parseInline } from "../src/ui/markdown.js";

export interface DocTable {
  readonly head: readonly string[];
  readonly rows: readonly (readonly string[])[];
  readonly numeric: readonly boolean[];
}

export interface DocMeta {
  /** Belgenin başlığı — cevaptaki en yakın başlıktan gelir. */
  readonly title: string;
  /** Şirket adı; antet. */
  readonly org: string;
  /** Belgeyi doğuran soru — belgenin neyi yanıtladığını kaydeder. */
  readonly question: string;
}

/** Tarayıcıda tarih; sunucuda üretilse hidrasyon uyuşmazlığı olurdu. */
/** Hücredeki **kalın** işaretini biçime çevirir; silmez. */
function Cell({ text }: { text: string }) {
  return (
    <>
      {parseInline(text).map((t, i) =>
        t.kind === "bold" ? <strong key={i}>{t.value}</strong> : <span key={i}>{t.value}</span>,
      )}
    </>
  );
}

function stamp(): string {
  return new Intl.DateTimeFormat("tr-TR", {
    day: "2-digit",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date());
}

/** Excel'e giden metinden markdown işaretlerini soyar. */
function plain(v: string): string {
  return v.replace(/\*\*/g, "").replace(/`/g, "").trim();
}

/** Tablodan Excel yükü kurar. */
export function sheetFromTable(name: string, table: DocTable): ExportSheet {
  return {
    name: name.slice(0, 31),
    head: table.head.map(plain),
    // Hücredeki "**" hem Excel'de çirkin durur hem de sayıyı metne
    // çevirir: "**25.200.000**" toplanamaz.
    rows: table.rows.map((r) => r.map(plain)),
    numeric: table.numeric,
  };
}

async function downloadFile(
  title: string,
  sheets: readonly ExportSheet[],
  format: "xlsx" | "doc",
): Promise<string | null> {
  const res = await fetch("/api/export", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, sheets, format }),
  });

  if (!res.ok) {
    // Sessizce başarısız olmak en kötüsü: kullanıcı düğmeye basar, hiçbir
    // şey olmaz ve sistemin çalışmadığını düşünür.
    if (res.status === 401) return "Oturum düştü; sayfayı yenileyip tekrar deneyin.";
    return "Dosya oluşturulamadı.";
  }

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = window.document.createElement("a");
  a.href = url;
  a.download = `${title}.${format}`;
  window.document.body.appendChild(a);
  a.click();
  a.remove();
  // Hemen iptal edilirse indirme yarıda kalabilir.
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return null;
}

/**
 * BELGE KENDİ TOPLAMINI HESAPLAMAZ.
 *
 * İlk sürüm sayısal sütunları toplayıp belgenin altına bir "Toplam"
 * satırı koyuyordu. İlk gerçek tabloda sonuç şu oldu:
 *
 *   TRY toplam   25.200.000
 *   EUR toplam      411.200
 *   Toplam       51.222.400   ← iki kere sayılmış ve iki para birimi
 *                               birbirine eklenmiş
 *
 * İki ayrı kusur: tablonun içinde zaten duran ARA TOPLAM satırları
 * yeniden toplanıyor, ve farklı para birimleri tek bir sayıya
 * katlanıyor. İkisi de "ara toplam satırını tanı" ya da "para birimi
 * sütununu tanı" gibi sezgisel kurallarla yamanabilirdi; ama o
 * kuralların yanıldığı gün yanlış rakam EKRANDA DEĞİL, imzalanmış bir
 * kâğıdın üzerinde olur.
 *
 * Bu yüzden belge, cevabın gösterdiğinden fazlasını göstermez. Toplam
 * anlamlıysa modelin tabloya kendisi koyduğu satır zaten oradadır —
 * nitekim yukarıdaki örnekte ikisi de vardı.
 */

/** Excel'e gidecek sayfa yükü; belge tablosu değilse verilmez. */
export interface ExportSheet {
  readonly name: string;
  readonly head: readonly string[];
  readonly rows: readonly (readonly string[])[];
  readonly numeric: readonly boolean[];
}

export function DocumentSheet({
  meta,
  sheets,
  chart,
  children,
  onClose,
}: {
  meta: DocMeta;
  /** Excel düğmesi yalnızca aktarılabilir bir yük varsa görünür. */
  sheets?: readonly ExportSheet[];
  /** Grafik sekmesi — yoksa sekme hiç görünmez. */
  chart?: ReactNode;
  children: ReactNode;
  onClose: () => void;
}) {
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [when] = useState(stamp);
  const [tab, setTab] = useState<"doc" | "chart">("doc");
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    // Arkadaki sayfa kaymasın; belge açıkken odak belgede.
    const prev = window.document.body.style.overflow;
    window.document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      window.document.body.style.overflow = prev;
    };
  }, [onClose]);

  // PORTAL ŞART. Katman cevabın içinde kalsaydı iki şey bozulurdu:
  // `position: fixed` dönüştürülmüş bir atanın içinde ekrana değil o
  // ataya göre konumlanır; ve yazdırma biçemi "belge dışındaki her
  // şeyi gizle" derken belgeyi TAŞIYAN kutuyu da gizlerdi — kâğıt boş
  // çıkardı.
  return createPortal(
    <div className="doc-veil" onClick={onClose} role="presentation">
      <div
        className="doc-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={meta.title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="doc-bar">
          <span className="doc-bar-name">{meta.title}</span>
          {/* SEKME YALNIZCA GRAFİK VARSA ÇIKAR. Boş bir "Grafik"
              sekmesi, tıklayınca hiçbir şey göstermeyen bir düğmedir. */}
          {chart && (
            <div className="doc-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={tab === "doc"}
                className={tab === "doc" ? "on" : ""}
                onClick={() => setTab("doc")}
              >
                Belge
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === "chart"}
                className={tab === "chart" ? "on" : ""}
                onClick={() => setTab("chart")}
              >
                Grafik
              </button>
            </div>
          )}
          <div className="doc-bar-acts">
            {/* Excel VE Word aynı yükten üretilir; ikisi de yalnızca
                aktarılabilir bir tablo varsa görünür. */}
            {sheets && sheets.length > 0 && (
              <>
                {(["xlsx", "doc"] as const).map((f) => (
                  <button
                    key={f}
                    type="button"
                    className="doc-act"
                    disabled={busy}
                    onClick={() => {
                      setBusy(true);
                      setNote(null);
                      void downloadFile(meta.title, sheets, f)
                        .then(setNote)
                        .finally(() => setBusy(false));
                    }}
                  >
                    {f === "xlsx" ? "Excel" : "Word"}
                  </button>
                ))}
              </>
            )}
            <button type="button" className="doc-act" onClick={() => window.print()}>
              PDF olarak kaydet
            </button>
            <button ref={closeRef} type="button" className="doc-act doc-close" onClick={onClose}>
              Kapat
            </button>
          </div>
        </div>

        {note && <div className="doc-note">{note}</div>}

        <div className="doc-scroll">
          <article className="doc-page">
            <header className="doc-head">
              <div className="doc-org">{meta.org}</div>
              <div className="doc-stamp">{when}</div>
            </header>

            {/* İkisi de DOM'da kalır: yazdırma her zaman BELGEYİ basar,
                hangi sekme açık olursa olsun. Grafik ekran içindir;
                kâğıda giden şey belgenin kendisidir. */}
            <div className={tab === "doc" ? "" : "doc-hide"}>{children}</div>
            {chart && (
              <div className={`doc-chart${tab === "chart" ? "" : " doc-hide"}`}>{chart}</div>
            )}

            <footer className="doc-foot">
              {/* Belgenin kaynağı BELGENİN ÜZERİNDE durur: eline geçen
                  kişi rakamın nereden geldiğini sormak zorunda kalmasın. */}
              KAELON · {meta.org} · {when} · Bu belge işletmenin kendi kayıtlarından üretilmiştir.
            </footer>
          </article>
        </div>
      </div>
    </div>,
    window.document.body,
  );
}

/** Tablo belgesinin gövdesi. */
export function TableBody({ meta, table }: { meta: DocMeta; table: DocTable }) {
  return (
    <>
      <h1 className="doc-title">{meta.title}</h1>
      <p className="doc-sub">{meta.question}</p>
      <table className="doc-table">
        <thead>
          <tr>
            {table.head.map((h, c) => (
              <th key={c} className={table.numeric[c] ? "num" : ""}>
                <Cell text={h} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((r, i) => (
            <tr key={i}>
              {table.head.map((_, c) => (
                <td key={c} className={table.numeric[c] ? "num" : ""}>
                  <Cell text={r[c] ?? ""} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

/** Tablonun üstünde beliren eylem şeridi. */
export function TableActions({
  onOpen,
  onExport,
  busy,
}: {
  onOpen: () => void;
  onExport: (format: "xlsx" | "doc") => void;
  busy: boolean;
}) {
  return (
    <div className="tbl-acts">
      <button type="button" className="tbl-act" onClick={onOpen}>
        Belge
      </button>
      {/* Excel ve Word sohbetin İÇİNDEKİ tabloda da var: belgeyi
          açmadan indirebilmek, en sık istenen şeyi bir tık uzağa
          koyar. PDF için belge açılır — yazdırma biçemi orada. */}
      <button type="button" className="tbl-act" onClick={() => onExport("xlsx")} disabled={busy}>
        {busy ? "…" : "Excel"}
      </button>
      <button type="button" className="tbl-act" onClick={() => onExport("doc")} disabled={busy}>
        Word
      </button>
    </div>
  );
}

export { downloadFile };
