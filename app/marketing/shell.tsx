"use client";

/**
 * Tanıtım kabuğu — sabit üst çubuk, sürüklenen zemin, ayak.
 *
 * ZEMİN NEDEN SABİT: `.mk-bg` viewport'a çakılıdır, sayfayla birlikte
 * kaymaz. Kaydırdıkça içerik zeminin üzerinden geçer; zemin durur.
 * Derinlik hissi buradan gelir — paralaks numarası değil, tek katman.
 *
 * KAYDIRMA KİLİDİ: uygulama sabit yükseklikli olduğu için
 * `body { overflow: hidden }` tanımlı. Tanıtım sayfası uzundur ve o
 * kural onu KİLİTLER; ziyaretçi ilk ekrandan aşağısını göremez. CSS'te
 * `body:has(.mk)` ile de açılıyor, buradaki `:has()` desteklemeyen
 * tarayıcılar için güvence.
 */

import { useEffect, type ReactNode } from "react";
import { Footer } from "./footer.js";

/*
 * MENÜ GERÇEK SAYFALARA GİDER, ÇAPAYA DEĞİL.
 *
 * Önce `#ne-yapar` gibi çıplak çapalardı ve yalnızca ana sayfada
 * çalışıyordu: `/deneyin` üzerindeyken menüye tıklayan kişi hiçbir yere
 * gitmiyordu — bağlantı ölüydü ve bu, ürünün bozuk olduğu izlenimini
 * veren türden bir sessizlik.
 */
const LINKS = [
  { href: "/ne-yapar", label: "Ne yapar" },
  { href: "/gecis", label: "Geçiş" },
  { href: "/mevzuat", label: "Mevzuat" },
  { href: "/roller", label: "Roller" },
];

export function Shell({ children }: { children: ReactNode }) {
  useEffect(() => {
    const prevBody = document.body.style.overflow;
    const prevHtml = document.documentElement.style.overflow;
    document.body.style.overflow = "auto";
    document.documentElement.style.overflow = "auto";
    return () => {
      document.body.style.overflow = prevBody;
      document.documentElement.style.overflow = prevHtml;
    };
  }, []);

  return (
    <div className="mk">
      <div className="mk-bg" aria-hidden>
        <div className="mk-blob-a" />
        <div className="mk-blob-b" />
      </div>

      <header className="mk-top">
        <a className="mk-logo" href="/">
          KAELON
        </a>
        <nav className="mk-nav">
          {LINKS.map((l) => (
            <a key={l.href} href={l.href}>
              {l.label}
            </a>
          ))}
          <a href="/deneyin">Deneyin</a>
          <a className="mk-pill" href="/uygulama">
            Giriş
          </a>
        </nav>
      </header>

      {children}

      <Footer />
    </div>
  );
}
