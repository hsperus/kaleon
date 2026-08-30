/**
 * Kahraman bölümü — başlık ve canlı cevap kartı.
 *
 * KART NEDEN CANLI: ürünün tamamı tek bir davranışa dayanıyor —
 * soruyorsunuz, cevap geliyor. Bunu anlatmak yerine gösteriyoruz.
 * Soru yazılıyor, adım tamamlanıyor, cevap yükseliyor, altında kaynak
 * satırı duruyor. Sıralama CSS gecikmeleriyle kurulu; JavaScript yok,
 * durum yok, sunucuda da aynı görünür.
 *
 * SEÇİLEN ÖRNEK ZARAR GÖSTERİYOR. Brüt kâr var ama dönem zararla
 * kapanıyor. Ürünün iddiası "iyi haber üretmek" değil, doğru olanı
 * söylemek; vitrin de onu söylemeli.
 */
export function Hero() {
  return (
    <>
      <section className="mk-hero">
        <span className="mk-badge k-fade">
          <i /> 136 iş · tek arayüz · denetim kaydı açık
        </span>
        <h1 className="mk-h1">
          <span className="k-rise" style={{ animationDelay: ".05s" }}>
            Soruyorsunuz.
          </span>
          <span className="dim k-rise" style={{ animationDelay: ".18s" }}>
            Cevap geliyor.
          </span>
        </h1>
        <p className="mk-lede k-rise" style={{ animationDelay: ".32s" }}>
          Menü yok, modül yok, danışman yok. Türkçe sorun; bilanço, bordro,
          amortisman ya da üretim tarafından ne gerekiyorsa o gelsin.
        </p>
        <div className="mk-acts k-rise" style={{ animationDelay: ".44s" }}>
          <a className="mk-pill-lg" href="/uygulama">
            Sisteme gir
          </a>
          <a className="mk-pill-ghost" href="#ne-yapar">
            Ne yapabildiğini gör
          </a>
        </div>
      </section>

      <div className="mk-demo-wrap">
        <div className="mk-demo k-fade" style={{ animationDelay: ".6s" }}>
          <div className="mk-demo-bar">
            <i /> KAELON · SOHBET
          </div>
          <div className="mk-demo-body">
            <p className="mk-demo-q">
              <span>Bu ay kâr ettik mi?</span>
              <i />
            </p>

            <div className="mk-step">
              <span className="mk-check">✓</span>
              Gelir tablosu çıkarıldı · 3 hesap grubu okundu
            </div>

            <p className="mk-demo-p">
              <b>379.610 ₺ brüt kâr</b> ettiniz ama amortisman ve personel
              gideriyle birlikte dönem <b className="bad">601.890 ₺ zararla</b>{" "}
              kapanıyor.
            </p>

            <table className="mk-demo-table">
              <tbody>
                <tr>
                  <td>Net satış</td>
                  <td>379.610</td>
                </tr>
                <tr>
                  <td>Amortisman</td>
                  <td>981.500</td>
                </tr>
                <tr className="total">
                  <td>Dönem sonucu</td>
                  <td>-601.890</td>
                </tr>
              </tbody>
            </table>

            <p className="mk-mono">YEVMİYE DEFTERİ · BUGÜN 09:14 · GÜVEN 0.92</p>
          </div>
        </div>
      </div>
    </>
  );
}
