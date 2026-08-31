/**
 * Ayrıntı sayfalarının ortak parçaları.
 *
 * DÖRT SAYFA AYNI İSKELETİ PAYLAŞIR: başlık bloğu ve alttaki "sırada ne
 * var" bandı. Her sayfada ayrı yazılsaydı biri güncellenir, üçü
 * unutulurdu — ve ziyaretçi sayfalar arasında geçerken ürünün
 * dağınık olduğunu düşünürdü.
 */
import type { ReactNode } from "react";

export function DetailHead({
  eyebrow,
  title,
  lede,
}: {
  eyebrow: string;
  title: ReactNode;
  lede: string;
}) {
  return (
    <>
      <p className="mk-eyebrow k-rise-sm">{eyebrow}</p>
      <h1 className="mk-h2 k-rise">{title}</h1>
      <p className="mk-sub k-rise-sm">{lede}</p>
    </>
  );
}

const SAYFALAR = [
  { href: "/ne-yapar", label: "Ne yapar", note: "Belge, grafik, onay formu" },
  { href: "/gecis", label: "Geçiş", note: "Excel ve eski ERP'den taşıma" },
  { href: "/mevzuat", label: "Mevzuat", note: "TDHP, VUK, bordro, e-Fatura" },
  { href: "/roller", label: "Roller", note: "Kim neyi görür" },
];

/** Sayfanın sonundaki gezinme — okuyan kişi burada bırakılmaz. */
export function DetailNext({ current }: { current: string }) {
  const diger = SAYFALAR.filter((s) => s.href !== current);
  return (
    <nav className="dt-next">
      <p className="mk-eyebrow">Devamı</p>
      <div>
        {diger.map((s) => (
          <a key={s.href} href={s.href}>
            <b>{s.label}</b>
            <span>{s.note}</span>
          </a>
        ))}
        <a className="on" href="/deneyin">
          <b>Şirketinizle deneyin</b>
          <span>Size ait gerçek bir ortam kurulur</span>
        </a>
      </div>
    </nav>
  );
}
