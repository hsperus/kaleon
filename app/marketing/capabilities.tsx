/**
 * "Ne yapar" — üç çıktı biçimi, üçü de gerçek örnekle.
 *
 * TOOL ADI GEÇMİYOR. `create_watch`, `list_watchable_fields` gibi iç
 * isimler ziyaretçiye hiçbir şey anlatmaz; onların gördüğü şey çıktının
 * kendisidir. Kartlar bu yüzden BELGE / GRAFİK / ONAY FORMU diye
 * ayrılıyor — sistemin iç yapısına göre değil, ekranda beliren şeye göre.
 *
 * GRAFİK ÇUBUKLARI GERÇEK ORANDA. Ocak 100.974 ₺, Aralık 86.120 ₺ →
 * son çubuk ilkinin %85'i. Tasarımda %64'e iniyordu; o eğim daha
 * gösterişliydi ama sayılarla uyuşmuyordu. Sayılarla yalan söylememeyi
 * satan bir ürünün vitrininde bunu yapamayız.
 */

/** Ocak→Aralık net maaş eğrisi; ilk aya göre yüzde. */
const BORDRO = [100, 100, 100, 96, 96, 93, 93, 90, 90, 87, 85, 85];

export function Capabilities() {
  return (
    <section className="mk-sec">
      <span className="mk-anchor" id="ne-yapar" />
      <p className="mk-eyebrow k-rise-sm">Ne yapar</p>
      <h2 className="mk-h2 k-rise">
        Her soru kendi biçiminde
        <br />
        <span className="dim">cevaplanır.</span>
      </h2>
      <p className="mk-sub k-rise-sm">
        Belge, tablo, grafik ya da onaylamanız gereken bir form. Aşağıdakiler
        gerçek çıktılar — 136 iş, tek arayüz.
      </p>

      <div className="mk-cards">
        <article className="mk-card k-rise">
          <p className="mk-kind">BELGE</p>
          <h3>Bilanço</h3>
          <p>
            &ldquo;31 Aralık itibarıyla bilançoyu çıkar&rdquo; — TDHP
            gruplarıyla, denksizse üzerinde yazar.
          </p>
          <div className="mk-mini">
            <div className="mk-mini-head">
              <span>AKTİF</span>
              <span>PASİF</span>
            </div>
            <div className="mk-mini-row">
              <span>
                Hazır Değerler <b>10.800.000</b>
              </span>
              <span>
                Ticari Borçlar <b>2.900.000</b>
              </span>
            </div>
            <div className="mk-mini-row">
              <span>
                Stoklar <b>5.000.000</b>
              </span>
              <span>
                Sermaye <b>19.070.000</b>
              </span>
            </div>
            <div className="mk-mini-foot">
              <span>21.433.316</span>
              <span className="mk-ok">DENK</span>
              <span>21.433.316</span>
            </div>
          </div>
        </article>

        <article className="mk-card k-rise" style={{ animationDelay: ".08s" }}>
          <p className="mk-kind">GRAFİK</p>
          <h3>Bordro seyri</h3>
          <p>
            Net maaş yıl içinde düşer: kümülatif matrah büyüdükçe dilim
            yükselir. Tek ayın on iki katı yanlış cevaptır.
          </p>
          <div className="mk-mini">
            <div className="mk-bars">
              {BORDRO.map((h, i) => (
                <i
                  key={i}
                  style={{ height: `${h}%`, animationDelay: `${i * 0.04}s` }}
                />
              ))}
            </div>
            <div className="mk-bars-axis">
              <span>OCA · 100.974 ₺</span>
              <span>ARA · 86.120 ₺</span>
            </div>
          </div>
        </article>

        <article className="mk-card k-rise" style={{ animationDelay: ".16s" }}>
          <p className="mk-kind">ONAY FORMU</p>
          <h3>Kalıcı izleme</h3>
          <p>
            Yazan her işlem alanları doldurulmuş bir formla önünüze gelir. Siz
            onaylamadan hiçbir kayıt oluşmaz.
          </p>
          <div className="mk-form">
            <span className="mk-wait">ONAYINIZI BEKLİYOR</span>
            <p className="mk-form-k">Koşul</p>
            <p className="mk-form-v">
              Kullanılabilir bakiye 500.000 ₺ altına düşerse
            </p>
            <div className="mk-form-acts">
              <span className="no">Vazgeç</span>
              <span className="yes">Onayla</span>
            </div>
          </div>
        </article>
      </div>
      <a className="mk-more k-rise-sm" href="/ne-yapar">
        Belge, grafik ve onay formunu ayrıntılı gör <span aria-hidden>→</span>
      </a>

    </section>
  );
}
