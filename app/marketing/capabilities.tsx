/**
 * "Her soru, kendi biçiminde cevaplanır."
 *
 * NEDEN ÜÇ KART VE NEDEN BUNLAR: bir ERP'nin cevabı her zaman metin
 * değildir. Mali müşavir belge ister, patron eğilim arar, yazan bir
 * işlem onay ister. Üçü ayrı ekranlar olsaydı kullanıcı hangi ekrana
 * gideceğini bilmek zorunda kalırdı — ürünün tamamı zaten bunu
 * ortadan kaldırmak için var.
 *
 * KARTLAR ÖNİZLEME TAŞIYOR, İKON DEĞİL. Bir ikon "belge üretebilir"
 * der; küçük bir bilanço tablosu neye benzediğini gösterir. İkincisi
 * kanıt, birincisi iddia.
 *
 * GRAFİK GERÇEK BİR OLGUYU ANLATIYOR: net maaş yıl içinde düşer
 * çünkü gelir vergisi dilimi büyür. Uydurma bir eğri çizmek yerine
 * Türkiye'de her bordrocunun tanıdığı basamağı çizdik.
 */

/** Bordro basamağı — yıl içinde vergi dilimi büyüdükçe net maaş düşer. */
const NET_MAAS = [100, 100, 92, 86, 86, 79, 79, 72, 72, 66, 66, 66];

export function Capabilities() {
  return (
    <section id="ne-yapar" className="v-sec">
      <h2 className="v-h2">
        Her soru,
        <br />
        <span className="dim">kendi biçiminde cevaplanır.</span>
      </h2>

      <div className="v-cards">
        <article className="v-card">
          <h3>Belge</h3>
          <p>Bilanço, gelir tablosu, bordro. Mali müşavirinizin beklediği düzende.</p>
          <div className="v-mini">
            <div className="v-mini-row">
              <span>Hazır Değerler</span>
              <span className="val">10.800.000</span>
            </div>
            <div className="v-mini-row">
              <span>Stoklar</span>
              <span className="val">5.000.000</span>
            </div>
            <div className="v-mini-row total">
              <span>Aktif toplam</span>
              <span>21.433.316</span>
            </div>
          </div>
        </article>

        <article className="v-card" style={{ animationDelay: ".07s" }}>
          <h3>Grafik</h3>
          <p>Net maaş yıl içinde neden düşer? Vergi dilimi büyür. Grafik anlatır.</p>
          <div className="v-mini">
            <div className="v-bars">
              {NET_MAAS.map((h, i) => (
                <i
                  key={i}
                  style={{
                    height: `${h}%`,
                    // Her çubuk bir öncekinden biraz sonra yükselir:
                    // hepsi aynı anda çıksaydı bu bir grafik değil bir
                    // blok olurdu.
                    animationRange: `entry ${12 + i * 2}% cover ${34 + i * 2}%`,
                  }}
                />
              ))}
            </div>
            <div className="v-bars-x">
              <span>Ocak</span>
              <span>Aralık</span>
            </div>
          </div>
        </article>

        <article className="v-card" style={{ animationDelay: ".14s" }}>
          <h3>Onay</h3>
          <p>Yazan her işlem önce önünüze gelir. Siz onaylamadan kayıt oluşmaz.</p>
          <div className="v-mini">
            <div className="v-mini-k">Koşul</div>
            <div className="v-mini-v">Bakiye 500.000 ₺ altına düşerse bildir</div>
            <div className="v-mini-acts">
              <span className="ghost">Vazgeç</span>
              <span className="go">Onayla</span>
            </div>
          </div>
        </article>
      </div>
    </section>
  );
}
