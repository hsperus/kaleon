"use client";

/**
 * Roller sayfası.
 *
 * YETKİ BİR EKRAN GİZLEME AYARI DEĞİLDİR. Rolün göremediği araç
 * modele hiç gönderilmez; yapay zekânın uydurabileceği bir şey
 * kalmaz. Sayfanın tamamı bu tek cümleyi kanıtlıyor — çubuklar
 * gerçek sayılardan geliyor.
 */

import { PageHead, Reveal, useReveal } from "./shell.js";

const ROLES = [
  { r: "Patron", n: 139, d: "Her şey. Gelir tablosu, bilanço, nakit, bordro, üretim." },
  { r: "CFO", n: 81, d: "Mali tarafın tamamı; üretim tezgâhının detayı değil." },
  { r: "Üretim Müdürü", n: 74, d: "Fabrika, iş emri, kapasite, kalite. Nakit ve maaş yok." },
  { r: "Satın Alma", n: 47, d: "Talep, teklif, sipariş, fatura eşleştirme." },
  { r: "Depo Sorumlusu", n: 36, d: "Mal kabul, sevkiyat, sayım, stok. Fiyat ve maliyet yok." },
  { r: "İK Müdürü", n: 27, d: "İzin, vardiya, bordro okuma. Bordroyu çalıştıramaz." },
  { r: "Operatör", n: 15, d: "Kendi tezgâhı, kendi iş emri, kendi izni." },
];

function Bar({ n, max }: { n: number; max: number }) {
  const { ref, shown } = useReveal<HTMLDivElement>();
  return (
    <div ref={ref} className="rl-bar">
      <i style={{ width: shown ? `${(n / max) * 100}%` : "0%" }} />
    </div>
  );
}

export function Roles() {
  const max = ROLES[0]!.n;
  return (
    <main className="mk-page">
      <PageHead
        eyebrow="Roller"
        title={
          <>
            Aynı soru.
            <br />
            <span className="mk-dim">Farklı cevaplar.</span>
          </>
        }
        lede="Depo sorumlusu 'bu ay kâr ettik mi' diye soramaz. Cevabı gizlendiği için değil — o soruyu cevaplayacak araç ona hiç gönderilmediği için."
      />

      <div className="rl-list">
        {ROLES.map((r, i) => (
          <Reveal key={r.r} delay={i * 55}>
            <article className="rl-row">
              <div className="rl-meta">
                <span className="rl-name">{r.r}</span>
                <span className="rl-n">{r.n}</span>
              </div>
              <Bar n={r.n} max={max} />
              <p className="rl-d">{r.d}</p>
            </article>
          </Reveal>
        ))}
      </div>

      <Reveal>
        <div className="rl-rule">
          <h2>Yazan her işlem önünüze gelir.</h2>
          <p>
            Fatura kesmek, bordro çalıştırmak, amortisman ayırmak — hepsi alanları
            doldurulmuş bir onay formuyla gelir. Siz göndermeden hiçbir kayıt
            oluşmaz. Yapay zekâ hazırlar, sistem doğrular, insan onaylar.
          </p>
        </div>
      </Reveal>

      <Reveal>
        <div className="mk-end">
          <a className="mk-cta" href="/uygulama">
            Sisteme gir
          </a>
        </div>
      </Reveal>
    </main>
  );
}
