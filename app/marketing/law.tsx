"use client";

/**
 * Mevzuat sayfası.
 *
 * ÜRÜNÜN EN SOMUT AYRIMI BURASI. SAP'de hesap planı kurulumda
 * tanımlanır, amortisman modülü ayrıca kurulur, bordro için
 * yerelleştirme paketi alınır. Burada hepsi kodun içinde ve testli.
 * Bu yüzden sayfa iddia değil RAKAM gösteriyor: her kartta mevzuatın
 * kendi sayısı var.
 */

import { PageHead, Reveal } from "./shell.js";

const ITEMS = [
  {
    k: "Tek Düzen Hesap Planı",
    n: "1xx–7xx",
    d: "Muhasebe Sistemi Uygulama Genel Tebliği kodları hazır gelir. Mali müşavir, vergi dairesi ve bağımsız denetim bu kodları bekler.",
  },
  {
    k: "VUK amortismanı",
    n: "%50 tavan",
    d: "Azalan bakiyelerde oran normalin iki katıdır ama yüzde elliyi geçemez. Son yıl kalanın tamamı yazılır, yoksa varlık hiç sıfırlanmaz.",
  },
  {
    k: "Kıst amortisman",
    n: "VUK 320",
    d: "Binek otomobilde iktisap yılı için yalnızca kalan ay kadar ayrılır ve ay kesri tam ay sayılır. Makineye uygulanmaz.",
  },
  {
    k: "2026 bordrosu",
    n: "28.075,50 ₺",
    d: "Net asgari ücret. Kümülatif matrah, SGK taban ve tavanı, asgari ücret istisnası — hepsi resmî tarifeye göre.",
  },
  {
    k: "Gelir vergisi tarifesi",
    n: "5 dilim",
    d: "Ücret gelirlerinin tarifesi ücret dışı gelirlerden farklıdır. Yanlışını kullanmak orta gelirli her çalışanı fazla vergilendirir.",
  },
  {
    k: "e-Fatura · e-İrsaliye",
    n: "UBL-TR 1.2",
    d: "Belge üretilir, gönderim entegratörün işidir. Bu sistemde gönderim aracı yoktur ve olmayacaktır.",
  },
  {
    k: "e-Defter",
    n: "XBRL-GL",
    d: "Yevmiye ve kebir defterleri mevzuatın istediği biçimde üretilir.",
  },
  {
    k: "İş Kanunu 4857",
    n: "20 gün",
    d: "Elli yaş üstü ve on sekiz yaş altı çalışana kıdeminden bağımsız en az yirmi gün izin. Kıdem ve ihbar tazminatı, fazla mesai hesabı dahil.",
  },
];

export function Law() {
  return (
    <main className="mk-page">
      <PageHead
        eyebrow="Mevzuat"
        title={
          <>
            Yorumlanacak bir şey değil.
            <br />
            <span className="mk-dim">Kodun içinde.</span>
          </>
        }
        lede="Aşağıdakiler ayar değil. Her biri vergi matrahını doğrudan değiştiriyor ve her birinin testi var."
      />

      <div className="lw-grid">
        {ITEMS.map((it, i) => (
          <Reveal key={it.k} delay={(i % 2) * 70}>
            <article className="lw-card">
              <span className="lw-n">{it.n}</span>
              <h3>{it.k}</h3>
              <p>{it.d}</p>
            </article>
          </Reveal>
        ))}
      </div>

      <Reveal>
        <div className="mk-end">
          <p>
            SAP'de bunların her biri ayrı bir kurulum kalemidir. Burada şirket
            adını yazmakla başlıyorsunuz.
          </p>
          <a className="mk-cta" href="/uygulama">
            Sisteme gir
          </a>
        </div>
      </Reveal>
    </main>
  );
}
