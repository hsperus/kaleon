"use client";

/**
 * Tanıtım sayfalarının ortak kabuğu.
 *
 * TEK SAYFA ÇOK UZUNDU. Her şey `/` altındaydı: 5134 piksel, altı
 * bölüm, dört sekme. Ziyaretçi ne aradığını bulamıyordu ve hiçbir
 * bölümün kendi adresi yoktu — "mevzuat tarafını gör" diye link
 * paylaşmak mümkün değildi.
 *
 * Artık her fikir kendi sayfasında. Kabuk burada tek yerde durur;
 * sayfalar yalnızca kendi içeriğini yazar.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";

/** Görünür olunca bir kez tetiklenen açığa çıkma. */
export function useReveal<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setShown(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            setShown(true);
            io.disconnect();
          }
        }
      },
      { threshold: 0.12, rootMargin: "0px 0px -50px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return { ref, shown };
}

export function Reveal({
  children,
  delay = 0,
  className = "",
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
}) {
  const { ref, shown } = useReveal<HTMLDivElement>();
  return (
    <div
      ref={ref}
      className={`mk-rv ${className}${shown ? " in" : ""}`}
      style={{ transitionDelay: `${delay}ms` }}
    >
      {children}
    </div>
  );
}

const LINKS = [
  { href: "/ne-yapar", label: "Ne yapar" },
  { href: "/mevzuat", label: "Mevzuat" },
  { href: "/roller", label: "Roller" },
];

export function Shell({ children }: { children: ReactNode }) {
  const path = usePathname();

  /*
   * GÖVDE KAYDIRMASI AÇILIR.
   *
   * Uygulama sabit yükseklikli olduğu için `body { overflow: hidden }`
   * tanımlı. Tanıtım sayfaları uzundur ve o kural onları KİLİTLER —
   * ziyaretçi ilk ekrandan aşağısını hiç göremez. CSS'te
   * `body:has(.mk)` ile de açılıyor; bu, `:has()` desteklemeyen
   * tarayıcılar için güvence.
   */
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "auto";
    document.documentElement.style.overflow = "auto";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  return (
    <div className="mk">
      <header className="mk-top">
        <a className="mk-logo" href="/">
          KAELON
        </a>
        <nav className="mk-nav">
          {LINKS.map((l) => (
            <a key={l.href} href={l.href} className={path === l.href ? "on" : ""}>
              {l.label}
            </a>
          ))}
          <a className="mk-enter" href="/uygulama">
            Giriş
          </a>
        </nav>
      </header>

      {children}

      <footer className="mk-foot">
        <span className="mk-foot-logo">KAELON</span>
        <nav>
          {LINKS.map((l) => (
            <a key={l.href} href={l.href}>
              {l.label}
            </a>
          ))}
        </nav>
        <span className="mk-foot-note">Türk imalat sanayii için</span>
      </footer>
    </div>
  );
}

/** Sayfa başlığı — her tanıtım sayfası bununla açılır. */
export function PageHead({
  eyebrow,
  title,
  lede,
}: {
  eyebrow: string;
  title: ReactNode;
  lede?: string;
}) {
  return (
    <header className="mk-head">
      <Reveal>
        <p className="mk-eyebrow">{eyebrow}</p>
      </Reveal>
      <Reveal delay={80}>
        <h1 className="mk-h1">{title}</h1>
      </Reveal>
      {lede && (
        <Reveal delay={160}>
          <p className="mk-lede">{lede}</p>
        </Reveal>
      )}
    </header>
  );
}
