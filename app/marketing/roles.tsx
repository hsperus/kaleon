/**
 * Roller — aynı soru, farklı cevaplar.
 *
 * ÇUBUK BİR SÜS DEĞİL, ÖLÇÜ. Genişlik rolün erişebildiği araç sayısının
 * patrona oranı: operatör 15/139 → %11. Ürünün en sert iddiası bu
 * bölümde ve grafik onu doğruluyor.
 *
 * "GÖREMEDİĞİNİZ VERİYİ YAPAY ZEKÂ DA GÖREMEZ" cümlesi mimariyi
 * anlatıyor: yetkisiz araç modele hiç gönderilmiyor. Ekran gizleme
 * değil, katalog filtresi — uydurabileceği bir şey kalmıyor.
 */

const ROLES = [
  { name: "Patron", n: 139, w: 100, d: "Her şey. Gelir tablosu, bilanço, nakit, bordro, üretim." },
  { name: "CFO", n: 81, w: 58, d: "Mali tarafın tamamı; üretim tezgâhının detayı değil." },
  { name: "Üretim Müdürü", n: 74, w: 53, d: "Fabrika, iş emri, kapasite, kalite. Nakit ve maaş yok." },
  { name: "Depo Sorumlusu", n: 36, w: 26, d: "Mal kabul, sevkiyat, sayım, stok. Fiyat ve maliyet yok." },
  { name: "Operatör", n: 15, w: 11, d: "Kendi tezgâhı, kendi iş emri, kendi izni." },
];

export function Roles() {
  return (
    <>
      <section className="mk-sec">
        <span className="mk-anchor" id="roller" />
        <p className="mk-eyebrow k-rise-sm">Roller</p>
        <h2 className="mk-h2 k-rise">
          Aynı soru.
          <br />
          <span className="dim">Farklı cevaplar.</span>
        </h2>
        <p className="mk-sub k-rise-sm">
          Göremediğiniz veriyi yapay zekâ da göremez. Yetkisi olmayan araç
          modele hiç gönderilmez — uydurabileceği bir şey kalmaz.
        </p>

        <div className="mk-roles">
          {ROLES.map((r) => (
            <div className="mk-role" key={r.name}>
              <span className="mk-role-name">
                {r.name}
                <b>{r.n}</b>
              </span>
              <span className="mk-role-bar" style={{ width: `${r.w}%` }} />
              <span className="mk-role-d">{r.d}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="mk-end">
        <h2 className="k-rise">
          Yapay zekâ hazırlar.
          <br />
          Sistem doğrular.
          <br />
          <span className="dim">İnsan onaylar.</span>
        </h2>
        <a className="mk-more k-rise-sm" href="/roller">
        Rol–modül matrisini gör <span aria-hidden>→</span>
      </a>

    </section>
    </>
  );
}
