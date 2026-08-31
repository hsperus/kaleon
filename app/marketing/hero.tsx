/**
 * Kahraman bölümü — başlık ve örnek cevap kartı.
 *
 * KART NEDEN CANLI: ürünün tamamı tek bir davranışa dayanıyor —
 * soruyorsunuz, cevap geliyor. Bunu anlatmak yerine gösteriyoruz.
 * Soru duruyor, cevap yükseliyor, altında tablo açılıyor. Sıralama
 * CSS gecikmeleriyle kurulu; JavaScript yok, durum yok, sunucuda da
 * aynı görünür.
 *
 * SEÇİLEN ÖRNEK ZARAR GÖSTERİYOR. Brüt kâr var ama dönem zararla
 * kapanıyor. Ürünün iddiası "iyi haber üretmek" değil, doğru olanı
 * söylemek; vitrin de onu söylemeli.
 *
 * BAŞLIK BİR CÜMLEDİR, İKİ SLOGAN DEĞİL: "Şirketinize
 * sorabilirsiniz." İkinci satır gradyanla ayrılıyor ama cümle
 * bölünmüyor — okuyan kişi iki ayrı iddia değil tek bir vaat görüyor.
 */
export function Hero() {
  return (
    <>
      <section className="v-hero">
        {/* Başlığın arkasındaki ışık. Dekoratif; ekran okuyucudan gizli. */}
        <div className="v-glow" aria-hidden />
        <h1 className="v-h1">
          <span className="v-mask" style={{ animationDelay: ".05s" }}>
            Şirketinize
          </span>
          <span className="v-mask v-grad" style={{ animationDelay: ".2s" }}>
            sorabilirsiniz.
          </span>
        </h1>
        <p className="v-lede" style={{ animationDelay: ".4s" }}>
          ERP’nin aylarca süren kurulumu, yüzlerce ekranı yok. Soruyu yazın;
          işinizin her köşesi tek cümleyle önünüzde.
        </p>
        <div className="v-acts" style={{ animationDelay: ".52s" }}>
          <a className="v-btn" href="/uygulama">
            Sisteme girin
          </a>
          <a className="v-link" href="#cevap">
            Nasıl çalışır <span aria-hidden>›</span>
          </a>
        </div>
      </section>

      <section id="cevap" className="v-demo-wrap">
        <div className="v-demo">
          <div className="v-demo-body">
            <div className="v-demo-ask">
              <span>Bu ay kâr ettik mi?</span>
            </div>

            <p className="v-demo-p">
              Brüt 379.610 ₺ kâr var; amortisman ve personel gideriyle dönem{" "}
              <b>601.890 ₺ zararla</b> kapandı. En büyük kalem Kaynak
              Robotu’nun ilk yıl amortismanı.
            </p>

            <table className="v-demo-table">
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
                  <td>−601.890</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
        <p className="v-demo-note">Gerçek yevmiye kayıtlarından, saniyeler içinde.</p>
      </section>
    </>
  );
}
