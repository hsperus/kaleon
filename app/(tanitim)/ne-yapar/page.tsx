import type { Metadata } from "next";
import { DetailHead, DetailNext } from "../../marketing/detail-shared.js";

export const metadata: Metadata = {
  title: "Ne yapar · KAELON",
  description:
    "Her soru kendi biçiminde cevaplanır: belge, tablo, grafik ya da onaylamanız " +
    "gereken bir form. 141 işin çıktısı ve nasıl göründüğü.",
};

/** Bilanço önizlemesi — TDHP gruplarıyla, denklik satırıyla. */
const AKTIF = [
  ["100 Kasa", "250.000"],
  ["102 Bankalar", "10.550.000"],
  ["120 Alıcılar", "4.843.316"],
  ["150 Hammadde", "3.200.000"],
  ["253 Tesis, makine", "4.000.000"],
  ["257 Birikmiş amort.", "-1.410.000"],
];
const PASIF = [
  ["320 Satıcılar", "2.900.000"],
  ["391 Hesaplanan KDV", "74.136"],
  ["500 Sermaye", "19.070.000"],
  ["590 Dönem zararı", "-601.890"],
];

/** Bordro seyri — kümülatif matrah büyüdükçe net düşer. */
const AYLAR = [
  ["OCA", 100_974, 100],
  ["ŞUB", 100_974, 100],
  ["MAR", 100_974, 100],
  ["NİS", 96_935, 96],
  ["MAY", 96_935, 96],
  ["HAZ", 93_906, 93],
  ["TEM", 93_906, 93],
  ["AĞU", 90_877, 90],
  ["EYL", 90_877, 90],
  ["EKİ", 87_848, 87],
  ["KAS", 86_120, 85],
  ["ARA", 86_120, 85],
] as const;

export default function Page() {
  return (
    <>
      <section className="mk-sec">
        <DetailHead
          eyebrow="Ne yapar"
          title={
            <>
              Cevap bir paragraf değil.
              <br />
              <span className="dim">Bakılacak bir şey.</span>
            </>
          }
          lede={
            "Aynı soru bir tabloyu, bir belgeyi, bir grafiği ya da onaylamanız " +
            "gereken bir formu getirebilir. Hangi biçimin doğru olduğuna sorunun " +
            "kendisi karar verir; aşağıdakiler gerçek çıktılar."
          }
        />

        {/* ── BELGE ── */}
        <article className="dt-block k-rise">
          <header>
            <span className="mk-kind">BELGE</span>
            <h2>Bilanço</h2>
            <p>
              &ldquo;31 Aralık itibarıyla bilançoyu çıkar.&rdquo; TDHP
              gruplarıyla, birikmiş amortisman kendi satırında eksi olarak.
              Denk değilse üstünde yazar — denk göstermek için bir kalemi
              düzeltmez.
            </p>
          </header>

          <div className="dt-sheet">
            <div className="dt-sheet-head">
              <span>AKTİF</span>
              <span>PASİF</span>
            </div>
            <div className="dt-sheet-body">
              <table>
                <tbody>
                  {AKTIF.map(([ad, tutar]) => (
                    <tr key={ad}>
                      <td>{ad}</td>
                      <td>{tutar}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <table>
                <tbody>
                  {PASIF.map(([ad, tutar]) => (
                    <tr key={ad}>
                      <td>{ad}</td>
                      <td>{tutar}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="dt-sheet-foot">
              <span>21.433.316</span>
              <span className="mk-ok">DENK</span>
              <span>21.433.316</span>
            </div>
          </div>
          <p className="mk-mono">
            YEVMİYE DEFTERİ · 17 FİŞ OKUNDU · GÜVEN 0.96
          </p>
        </article>

        {/* ── GRAFİK ── */}
        <article className="dt-block k-rise">
          <header>
            <span className="mk-kind">GRAFİK</span>
            <h2>Bordro seyri</h2>
            <p>
              Net maaş yıl içinde düşer: kümülatif matrah büyüdükçe gelir
              vergisi dilimi yükselir. Bir ayın on iki katını almak yanlış
              cevaptır ve fark tek bir çalışanda bile on binlerce lira olur.
            </p>
          </header>

          <div className="dt-chart">
            {AYLAR.map(([ay, tutar, yuzde]) => (
              <div className="dt-bar" key={ay}>
                <i style={{ height: `${yuzde}%` }} />
                <span className="dt-bar-v">{(tutar / 1000).toFixed(1)}k</span>
                <span className="dt-bar-x">{ay}</span>
              </div>
            ))}
          </div>
          <p className="mk-mono">
            BORDRO KOŞUSU · 5 ÇALIŞAN · 2026 GİB TARİFESİ
          </p>
        </article>

        {/* ── ONAY FORMU ── */}
        <article className="dt-block k-rise">
          <header>
            <span className="mk-kind">ONAY FORMU</span>
            <h2>Yazan her işlem</h2>
            <p>
              141 işin 77&apos;si veri yazar. Hiçbiri doğrudan çalışmaz: alanları
              doldurulmuş bir form önünüze gelir, siz onaylamadan kayıt
              oluşmaz. Vazgeçmek de bir sonuçtur ve iz bırakır.
            </p>
          </header>

          <div className="dt-form">
            <div className="dt-form-top">
              <span className="mk-wait">ONAYINIZI BEKLİYOR</span>
              <span className="mk-mono">L2 · GERİ ALINABİLİR</span>
            </div>
            <h3>Satış faturası kesilecek</h3>
            <dl>
              <div>
                <dt>Müşteri</dt>
                <dd>Daimler Truck Otomotiv Sanayi A.Ş.</dd>
              </div>
              <div>
                <dt>Kaynak</dt>
                <dd>IRS2026000001 sevk irsaliyesi · 3 satır</dd>
              </div>
              <div>
                <dt>Tutar</dt>
                <dd>
                  370.680,00 ₺ + KDV 74.136,00 ₺ = <b>444.816,00 ₺</b>
                </dd>
              </div>
              <div>
                <dt>Vade</dt>
                <dd>21 Eylül 2026 (30 gün)</dd>
              </div>
            </dl>
            <div className="dt-form-acts">
              <span className="no">Vazgeç</span>
              <span className="yes">Onayla ve kes</span>
            </div>
          </div>
          <p className="mk-mono">
            ONAY KAYDI DEĞİŞTİRİLEMEZ · KİM, NE ZAMAN, HANGİ KANALDAN
          </p>
        </article>

        {/* ── KAYNAK ── */}
        <article className="dt-block k-rise">
          <header>
            <span className="mk-kind">HER CEVABIN ALTINDA</span>
            <h2>Rakam nereden geldi</h2>
            <p>
              Her cevap kaynağını, okunan kayıt sayısını ve bir güven skorunu
              taşır. Veri eksikse rakam yerine <strong>&ldquo;bilinmiyor&rdquo;</strong>{" "}
              yazar — sıfır yazmaz. Bir ERP&apos;nin yapabileceği en pahalı
              sessiz hata, bilinmeyeni sıfır saymaktır.
            </p>
          </header>

          <div className="dt-src">
            <div>
              <b>Kaynak</b>
              <span>Yevmiye defteri, stok hareketleri, bordro koşusu</span>
            </div>
            <div>
              <b>Kapsam</b>
              <span>Okunan kayıt sayısı ve tarih aralığı</span>
            </div>
            <div>
              <b>Güven</b>
              <span>0.00–1.00 · eksik veri skoru düşürür</span>
            </div>
            <div>
              <b>Denetim</b>
              <span>Her tool çağrısı değiştirilemez kayda yazılır</span>
            </div>
          </div>
        </article>

        <DetailNext current="/ne-yapar" />
      </section>
    </>
  );
}
