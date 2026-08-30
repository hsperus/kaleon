"use client";

/**
 * Ana sayfa.
 *
 * TEK FİKİR, TEK EKRAN. Önceki hâli altı bölümü tek sayfaya
 * yığıyordu; ziyaretçi neye bakacağını bilmiyordu. Burada yalnızca
 * bir iddia var ve onun kanıtı: soru soruluyor, cevap geliyor.
 *
 * TOOL ADLARI KALDIRILDI. `list_watchable_fields` gibi bir isim
 * ziyaretçiye hiçbir şey anlatmaz; sistemin ne yaptığını anlatan şey
 * "Gelir tablosu okundu" cümlesidir. İç isimler ürünün içinde kalır.
 */

import { useEffect, useState } from "react";
import { RichText } from "../rich-text.js";
import { Reveal } from "./shell.js";

const QUESTION = "Bu ay kâr ettik mi?";

const ANSWER = `Ağustos ayında **379.610 TL brüt kâr** ettiniz ama amortisman ve personel gideriyle birlikte dönem **601.890 TL zararla** kapandı.

| Kalem | Tutar |
| --- | --- |
| Net satış | 379.610 |
| Amortisman | 981.500 |
| **Dönem sonucu** | **-601.890** |

Amortismanın 400.000 TL'si Kaynak Robotu'nun ilk yıl payı — önümüzdeki yıl 300.000 TL'ye düşer.`;

function LiveAnswer() {
  const [phase, setPhase] = useState<0 | 1 | 2 | 3>(0);
  const [typed, setTyped] = useState("");

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setTyped(QUESTION);
      setPhase(3);
      return;
    }
    const timers: number[] = [];
    let i = 0;
    const type = (): void => {
      i += 1;
      setTyped(QUESTION.slice(0, i));
      if (i < QUESTION.length) timers.push(window.setTimeout(type, 52));
      else {
        timers.push(window.setTimeout(() => setPhase(1), 380));
        timers.push(window.setTimeout(() => setPhase(2), 1080));
        timers.push(window.setTimeout(() => setPhase(3), 1780));
      }
    };
    timers.push(window.setTimeout(type, 750));
    return () => timers.forEach(clearTimeout);
  }, []);

  return (
    <div className="hr-demo">
      <div className="hr-ask">
        {typed}
        {phase === 0 && <i className="hr-caret" />}
      </div>

      {phase >= 1 && (
        <div className={`hr-step${phase >= 2 ? " done" : ""}`}>
          {phase >= 2 ? "Gelir tablosu okundu" : "Gelir tablosu okunuyor"}
        </div>
      )}

      {phase >= 3 && (
        <div className="hr-reply">
          <RichText text={ANSWER} org="Demo A.Ş." question={QUESTION} />
          <p className="hr-src">Yevmiye defteri · 4 kayıt · bugün 09:14</p>
        </div>
      )}
    </div>
  );
}

export function Hero() {
  return (
    <main className="hr">
      <section className="hr-top">
        <Reveal>
          <div className="hr-rule" aria-hidden="true">
            {Array.from({ length: 33 }, (_, i) => (
              <i key={i} className={i % 8 === 0 ? "maj" : ""} />
            ))}
          </div>
        </Reveal>

        <Reveal delay={60}>
          <h1 className="hr-h1">
            Soruyorsunuz.
            <br />
            <span className="hr-dim">Cevap geliyor.</span>
          </h1>
        </Reveal>

        <Reveal delay={140}>
          <p className="hr-lede">
            Menü yok, modül yok, danışman yok. Türk imalat sanayii için AI-native
            operasyonel işletim sistemi.
          </p>
        </Reveal>
      </section>

      <Reveal delay={200}>
        <LiveAnswer />
      </Reveal>

      <Reveal delay={80}>
        <div className="hr-acts">
          <a className="mk-cta" href="/uygulama">
            Sisteme gir
          </a>
          <a className="mk-ghost" href="/ne-yapar">
            Ne yapabildiğini gör
          </a>
        </div>
      </Reveal>

      {/* Üç kapı — her biri kendi sayfasına. Tek sayfada altı bölüm
          okumak yerine, ziyaretçi ne merak ediyorsa oraya gider. */}
      <section className="hr-doors">
        {[
          { href: "/ne-yapar", t: "Ne yapar", d: "Bilanço, amortisman, bordro, izleme — gerçek çıktılarla." },
          { href: "/mevzuat", t: "Mevzuat gömülü", d: "TDHP, VUK amortismanı, 2026 bordrosu, e-Fatura." },
          { href: "/roller", t: "Rol sınırlı", d: "Göremediğiniz veriyi yapay zekâ da göremez." },
        ].map((d, i) => (
          <Reveal key={d.href} delay={i * 90}>
            <a className="hr-door" href={d.href}>
              <span className="hr-door-t">{d.t}</span>
              <span className="hr-door-d">{d.d}</span>
              <span className="hr-door-go" aria-hidden="true">
                →
              </span>
            </a>
          </Reveal>
        ))}
      </section>
    </main>
  );
}
