import type { Metadata } from "next";
import { GUIDE_FACTS } from "../../../src/modules/documents/guide-facts.js";
import { SURECLER, SORGULAR, SINIRLAR } from "./data.js";

export const metadata: Metadata = {
  title: "Kullanıcı Rehberi · KAELON",
  description:
    "Veri girişinden sorgulamaya, onay kapısından mevzuata: KAELON'un tamamı. " +
    "Süreç sırasıyla, gerçek cümlelerle ve yapamadıklarıyla birlikte.",
};

/*
 * REHBER ÜRÜNÜN İÇİNDE YAŞIYOR, AYRI BİR DOSYADA DEĞİL.
 *
 * Bir PDF hazırlanıp paylaşılsaydı, ürün her değiştiğinde eskirdi ve
 * eskidiğini kimse fark etmezdi. Burada duran rehber ürünle birlikte
 * dağıtılıyor ve rakamları `guide-facts.ts`ten geliyor — o dosyayı da
 * canlı katalogla karşılaştıran bir test var.
 *
 * PDF İSTEYEN YAZDIRIR. Sayfa A4 dikey için biçimlendirildi: başlık
 * tekrarı, sayfa kırılımları ve kenar boşlukları yazdırma kuralında
 * tanımlı. Ürünün belge üretimi de aynı yolu kullanıyor — tarayıcının
 * kendi motoru, ayrı bir kütüphane değil.
 */

const BOLUMLER = [
  { id: "baslarken", ad: "Başlarken" },
  { id: "nasil-sorulur", ad: "Nasıl sorulur" },
  { id: "onay", ad: "Onay kapısı" },
  { id: "surecler", ad: "Süreçler" },
  { id: "sorgular", ad: "Sorgulama örnekleri" },
  { id: "belgeler", ad: "Belgeler" },
  { id: "roller", ad: "Roller ve yetki" },
  { id: "izleme", ad: "İzleme" },
  { id: "gecis", ad: "Eski sistemden geçiş" },
  { id: "sinirlar", ad: "Sınırlar" },
];

const ROL_ADI: Record<string, string> = {
  patron: "Patron",
  cfo: "CFO",
  uretim_muduru: "Üretim Müdürü",
  satin_alma: "Satın Alma",
  depo_sorumlusu: "Depo Sorumlusu",
  ik_muduru: "İK Müdürü",
  operator: "Operatör",
};

const SEVIYELER = [
  { n: "L0", ad: "Okuma", metin: "Hiçbir şeyi değiştirmez. Onay istemez.", onay: false },
  { n: "L1", ad: "Hafif yazma", metin: "İzin talebi, arıza bildirimi gibi geri alınabilir kayıtlar.", onay: true },
  { n: "L2", ad: "Belge yazma", metin: "Fatura, irsaliye, stok hareketi, personel kartı.", onay: true },
  { n: "L3", ad: "Mali işlem", metin: "Ödeme, bordro, dönem kapama. En yüksek eşik.", onay: true },
];

export default function Page() {
  const bugun = new Date().toLocaleDateString("tr-TR", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  return (
    <article className="gd">
      {/* ── Kapak ── */}
      <header className="gd-cover">
        <p className="gd-kicker">KAELON · Kullanıcı Rehberi</p>
        <h1>Şirketinizi konuşarak yönetmek.</h1>
        <p className="gd-lede">
          Bu rehber öğrenilecek bir menü listesi değil. Sistem zaten menüsüz
          çalışıyor: Türkçe soruyorsunuz, cevap geliyor. Burada yazan şey,
          <strong> ne sorabileceğiniz</strong>, <strong>ne olacağı</strong> ve{" "}
          <strong>nelerin olmayacağı</strong>.
        </p>
        <dl className="gd-facts">
          <div>
            <dt>Kayıtlı iş</dt>
            <dd>{GUIDE_FACTS.totalTools}</dd>
          </div>
          <div>
            <dt>Okuyan</dt>
            <dd>{GUIDE_FACTS.readTools}</dd>
          </div>
          <div>
            <dt>Yazan · onaylı</dt>
            <dd>{GUIDE_FACTS.writeTools}</dd>
          </div>
          <div>
            <dt>Rol</dt>
            <dd>{GUIDE_FACTS.roles}</dd>
          </div>
        </dl>
        <p className="gd-stamp">Sürüm tarihi: {bugun}</p>
      </header>

      {/* ── İçindekiler ── */}
      <nav className="gd-toc" aria-label="İçindekiler">
        <h2>İçindekiler</h2>
        <ol>
          {BOLUMLER.map((b, i) => (
            <li key={b.id}>
              <a href={`#${b.id}`}>
                <span className="gd-toc-n">{String(i + 1).padStart(2, "0")}</span>
                {b.ad}
              </a>
            </li>
          ))}
        </ol>
      </nav>

      {/* ── 01 Başlarken ── */}
      <section id="baslarken" className="gd-sec">
        <h2>
          <span className="gd-n">01</span> Başlarken
        </h2>
        <p>
          Giriş yaptığınızda tek bir ekran görürsünüz: solda geçmiş
          konuşmalarınız, ortada gündem, altta yazma çubuğu. Öğrenilecek bir
          modül ağacı, ezberlenecek bir işlem kodu yoktur.
        </p>
        <p>
          Gündemde o gün dikkatinizi çekmesi gerekenler durur: geciken siparişler,
          onay bekleyen işlemler, tetiklenen izleme kuralları. Bunlar rapor değil{" "}
          <em>uyarı</em>dır — bir şeyin yolunda gitmediğini söylerler.
        </p>

        <h3>Rolünüz ne gösterir</h3>
        <p>
          Sistemde {GUIDE_FACTS.roles} rol var ve her rol farklı sayıda iş görür.
          Bu bir ekran gizleme değildir:{" "}
          <strong>yetkiniz olmayan araç yapay zekâya hiç gönderilmez</strong>, o
          yüzden uydurabileceği bir şey de kalmaz.
        </p>
        <div className="gd-table-wrap">
          <table className="gd-table">
            <thead>
              <tr>
                <th>Rol</th>
                <th className="num">Görebildiği iş</th>
                <th className="num">Oran</th>
                <th>Kapsam</th>
              </tr>
            </thead>
            <tbody>
              {(Object.keys(GUIDE_FACTS.byRole) as (keyof typeof GUIDE_FACTS.byRole)[]).map((r) => (
                <tr key={r}>
                  <td>{ROL_ADI[r]}</td>
                  <td className="num">{GUIDE_FACTS.byRole[r]}</td>
                  <td className="num">
                    %{Math.round((GUIDE_FACTS.byRole[r] / GUIDE_FACTS.totalTools) * 100)}
                  </td>
                  <td className="gd-dim">
                    {r === "patron" && "Her şey."}
                    {r === "cfo" && "Mali tarafın tamamı; tezgâh detayı değil."}
                    {r === "uretim_muduru" && "Fabrika, iş emri, kalite. Nakit ve maaş yok."}
                    {r === "satin_alma" && "Talep, teklif, sipariş, tedarikçi."}
                    {r === "depo_sorumlusu" && "Mal kabul, sevkiyat, sayım. Fiyat yok."}
                    {r === "ik_muduru" && "Kadro, izin, vardiya, bordro."}
                    {r === "operator" && "Kendi tezgâhı, kendi iş emri, kendi izni."}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ── 02 Nasıl sorulur ── */}
      <section id="nasil-sorulur" className="gd-sec">
        <h2>
          <span className="gd-n">02</span> Nasıl sorulur
        </h2>
        <p>
          Kendi kelimelerinizi kullanın. &quot;Müşteri&quot; deyin, sistem onu
          cari kartına çevirir; &quot;sayım&quot; deyin, stok sayımını bulur.
          Terminoloji öğrenmeniz gerekmez.
        </p>

        <h3>Cevabın üç parçası</h3>
        <ul className="gd-list">
          <li>
            <strong>Rakam ve cümle.</strong> Sorunun cevabı, gerektiğinde tablo ya
            da grafikle.
          </li>
          <li>
            <strong>Kaynak.</strong> Hangi kayıttan geldiği ve kaç kayıt okunduğu.
            &quot;Bu rakam nereden çıktı&quot; sorusunun cevabı her zaman
            ekrandadır.
          </li>
          <li>
            <strong>Uyarı.</strong> Eksik veri, kesilen liste, bilinmeyen kur.
            Cevabı zayıflatan ne varsa yazılır — gizlenmez.
          </li>
        </ul>

        <h3>Belirsiz soru sorulduğunda</h3>
        <p>
          Sistem tahmin etmez, sorar. &quot;Mehmet&apos;in izni&quot; dediğinizde
          iki Mehmet varsa ikisini de gösterir ve seçmenizi ister. Birini seçip
          devam etmek, yanlış kişinin bakiyesini göstermek demektir.
        </p>

        <div className="gd-callout">
          <h4>Bilinmeyen sıfır değildir</h4>
          <p>
            Bu, sistemin en önemli kuralı. Bir malzemenin maliyeti girilmemişse
            &quot;0 TL&quot; denmez, &quot;bilinmiyor&quot; denir. Sıfır bir
            iddiadır ve yanlış bir iddia, hiç cevap vermemekten kötüdür — çünkü
            ona güvenerek karar verirsiniz.
          </p>
        </div>
      </section>

      {/* ── 03 Onay kapısı ── */}
      <section id="onay" className="gd-sec">
        <h2>
          <span className="gd-n">03</span> Onay kapısı
        </h2>
        <p>
          Okuyan {GUIDE_FACTS.readTools} iş doğrudan çalışır. Yazan{" "}
          {GUIDE_FACTS.writeTools} işin <strong>tamamı</strong> önünüze gelir:
          hangi tool, hangi veriyle, ne yapacak. Siz onaylamadan hiçbir kayıt
          oluşmaz.
        </p>
        <div className="gd-table-wrap">
          <table className="gd-table">
            <thead>
              <tr>
                <th>Seviye</th>
                <th>Ne</th>
                <th>Örnek</th>
                <th>Onay</th>
              </tr>
            </thead>
            <tbody>
              {SEVIYELER.map((s) => (
                <tr key={s.n}>
                  <td>
                    <code>{s.n}</code>
                  </td>
                  <td>{s.ad}</td>
                  <td className="gd-dim">{s.metin}</td>
                  <td>{s.onay ? "Gerekir" : "Gerekmez"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <h3>Çok adımlı işler</h3>
        <p>
          &quot;Şu üç müşteriye fatura kes ve e-Fatura gönder&quot; dediğinizde
          altı ayrı onay istenmez. Sistem bir <strong>plan</strong> hazırlar,
          adımları size gösterir, tek onayla sırayla koşturur.
        </p>
        <ul className="gd-list">
          <li>
            <strong>Bir adım düşerse plan durur.</strong> Sonraki adımlar hiç
            denenmez — yarı tutarlı veri üretmemek için.
          </li>
          <li>
            <strong>Üç ayrı durum bildirilir:</strong> yapıldı, düştü, hiç
            denenmedi. Denenmeyen adım hâlâ yapılabilir; düşen adımın önce sebebi
            çözülmeli.
          </li>
          <li>
            <strong>Gördüğünüz liste koşar.</strong> Onay ekranındaki adımlarla
            kayıtlı adımların aynı olduğunu sunucu doğrular; farklıysa koşum
            reddedilir.
          </li>
        </ul>
      </section>

      {/* ── 04 Süreçler ── */}
      <section id="surecler" className="gd-sec">
        <h2>
          <span className="gd-n">04</span> Süreçler
        </h2>
        <p>
          Aşağıdaki bölümler modül sırasıyla değil <strong>belge zinciri</strong>{" "}
          sırasıyla yazıldı. Siz modülde çalışmıyorsunuz: teklif veriyor, sipariş
          alıyor, mal gönderiyor, fatura kesiyor, parayı tahsil ediyorsunuz.
        </p>

        {SURECLER.map((s) => (
          <div key={s.kod} className="gd-surec">
            <h3 id={`surec-${s.kod}`}>{s.ad}</h3>
            <p className="gd-surec-ozet">{s.ozet}</p>

            <ol className="gd-adimlar">
              {s.adimlar.map((a) => (
                <li key={a.no}>
                  <div className="gd-adim-bas">
                    <span className="gd-adim-no">{a.no}</span>
                    <h4>{a.baslik}</h4>
                    {a.onay && <span className="gd-onay">onay ister</span>}
                  </div>
                  <p>{a.metin}</p>
                  {a.ornek && (
                    <p className="gd-ornek">
                      <span className="gd-ornek-et">Şöyle deyin</span>
                      <q>{a.ornek}</q>
                    </p>
                  )}
                </li>
              ))}
            </ol>

            {s.tuzak && (
              <div className="gd-tuzak">
                <h4>Sık yapılan hata</h4>
                <p>{s.tuzak}</p>
              </div>
            )}
          </div>
        ))}
      </section>

      {/* ── 05 Sorgulama örnekleri ── */}
      <section id="sorgular" className="gd-sec">
        <h2>
          <span className="gd-n">05</span> Sorgulama örnekleri
        </h2>
        <p>
          Bunlar gerçek cümleler. Kopyalayıp yazabilir, kendi kelimelerinizle
          değiştirebilirsiniz.
        </p>
        {SORGULAR.map((g) => (
          <div key={g.baslik} className="gd-sorgu-grup">
            <h3>{g.baslik}</h3>
            <p className="gd-dim">{g.aciklama}</p>
            <div className="gd-table-wrap">
              <table className="gd-table">
                <thead>
                  <tr>
                    <th>Soru</th>
                    <th>Ne gelir</th>
                  </tr>
                </thead>
                <tbody>
                  {g.ornekler.map((o) => (
                    <tr key={o.soru}>
                      <td>
                        <q>{o.soru}</q>
                      </td>
                      <td className="gd-dim">{o.ne}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </section>

      {/* ── 06 Belgeler ── */}
      <section id="belgeler" className="gd-sec">
        <h2>
          <span className="gd-n">06</span> Belgeler
        </h2>
        <p>
          İstediğiniz biçimi söylemeniz yeter: <em>&quot;Excel olarak ver&quot;</em>,{" "}
          <em>&quot;Word&apos;e al&quot;</em>, <em>&quot;yazdırılabilir yap&quot;</em>.
          Tek bir indirme düğmesi çıkar — sorduğunuz biçimde.
        </p>
        <ul className="gd-list">
          <li>
            <strong>Antet.</strong> Her belge şirketinizin ticari unvanı, adresi,
            vergi dairesi ve numarasıyla çıkar. Olmayan alan basılmaz — boş bir
            &quot;Vergi No: —&quot; satırı eksikliği gizler.
          </li>
          <li>
            <strong>Her zaman A4 dikey.</strong> Ekrandaki önizleme milimetre
            cinsinden gerçek A4&apos;tür; ekranda taşan bir tablo kâğıtta da taşar.
          </li>
          <li>
            <strong>Dipnot.</strong> Ticaret sicil ve Mersis numarası her belgenin
            altında tekrar eder — çok sayfalı bir belgenin tek sayfası
            fotokopilenirse o sayfa da kime ait olduğunu söylemeli.
          </li>
          <li>
            <strong>Belge kendi toplamını uydurmaz.</strong> Cevapta olmayan bir
            &quot;Toplam&quot; satırı eklenmez: farklı para birimlerini toplayan
            ya da ara toplamı iki kez sayan bir rakam, imzalanmış bir kâğıdın
            üzerinde durur.
          </li>
        </ul>
      </section>

      {/* ── 07 Roller ── */}
      <section id="roller" className="gd-sec">
        <h2>
          <span className="gd-n">07</span> Roller ve yetki
        </h2>
        <p>Yetki iki bağımsız katmanda kontrol edilir:</p>
        <ol className="gd-list gd-numbered">
          <li>
            <strong>Katalog filtresi.</strong> Model yalnızca rolün yetkili olduğu
            araçları görür. Diğerlerinin var olduğunu bilmez.
          </li>
          <li>
            <strong>Çağrı denetimi.</strong> Araç çalıştırılmadan önce yetki
            yeniden kontrol edilir. Filtre atlansa bile çağrı reddedilir.
          </li>
        </ol>
        <div className="gd-callout">
          <h4>Görevler ayrılığı</h4>
          <p>
            Kendi talebinizi onaylayamazsınız. Malı sevk eden kişi faturayı
            kesemez. Bordroyu tanımlayan onu çalıştıramaz. Bunlar yetki değil
            <em> sorumluluk</em> ayrımıdır: aynı elde toplanan iki iş, hatanın
            hiçbir yerde çakışmaması demektir.
          </p>
        </div>
      </section>

      {/* ── 08 İzleme ── */}
      <section id="izleme" className="gd-sec">
        <h2>
          <span className="gd-n">08</span> İzleme
        </h2>
        <p>
          Kendi nöbetçilerinizi kurabilirsiniz:{" "}
          <q>Banka bakiyesi 50 milyonun altına düşerse bildir.</q> Kural saat
          başı çalışır — siz bakmıyorken de.
        </p>
        <ul className="gd-list">
          <li>
            Her izleme <strong>sahibinin yetkisiyle</strong> koşar. Göremediğiniz
            bir veriyi izlemeniz de göremez.
          </li>
          <li>
            Yalnızca <strong>okuyan</strong> işler izlenebilir. Arka planda
            kendiliğinden fatura kesen bir kural olamaz.
          </li>
          <li>
            Çalışmayan bir izleme sessiz kalmaz. Bozuk kural açıkça bildirilir —
            çalışmayan bir nöbetçi, olmayandan tehlikelidir çünkü korunduğunuzu
            sanırsınız.
          </li>
        </ul>
      </section>

      {/* ── 09 Geçiş ── */}
      <section id="gecis" className="gd-sec">
        <h2>
          <span className="gd-n">09</span> Eski sistemden geçiş
        </h2>
        <p>
          Dosyanızı düzeltmeyin, olduğu gibi verin. Sütun adları tanınır:{" "}
          <code>unvan</code>, <code>firma adı</code>, <code>cari kodu</code>,{" "}
          <code>vkn</code> — hepsinin karşılığı önceden tanımlı.
        </p>
        <ol className="gd-list gd-numbered">
          <li>
            <strong>Önizleme.</strong> Kaç satır yeni açılacak, kaçı güncellenecek,
            kaçı reddedilecek ve <em>neden</em> — hepsi tek ekranda.
          </li>
          <li>
            <strong>Onay.</strong> Onaylamazsanız hiçbir kayıt oluşmaz.
          </li>
          <li>
            <strong>İçe aktarma.</strong> Bağlanamayan satır reddedilir; uydurma
            bir cari ya da personel açılmaz.
          </li>
        </ol>
        <p className="gd-dim">
          Altı şablon: cari listesi, malzeme listesi, personel listesi, puantaj,
          satış siparişleri, banka bakiyeleri.
        </p>
      </section>

      {/* ── 10 Sınırlar ── */}
      <section id="sinirlar" className="gd-sec">
        <h2>
          <span className="gd-n">10</span> Sınırlar
        </h2>
        <p>
          Bir rehberin en dürüst bölümü, yapamadıklarını yazdığı yerdir. Bunları
          er ya da geç keşfedersiniz; burada yazılıysa bir sınırdır, yazılı
          değilse bir hayal kırıklığı.
        </p>
        <div className="gd-sinirlar">
          {SINIRLAR.map((s) => (
            <div key={s.baslik} className="gd-sinir">
              <h4>{s.baslik}</h4>
              <p>{s.metin}</p>
            </div>
          ))}
        </div>
      </section>

      <footer className="gd-foot">
        <p>
          KAELON · Kullanıcı Rehberi · {bugun} · {GUIDE_FACTS.totalTools} iş,{" "}
          {GUIDE_FACTS.migrations} şema sürümü
        </p>
        <p className="gd-dim">
          Bu rehber ürünle birlikte dağıtılır ve rakamları canlı katalogdan
          doğrulanır. Ayrı bir dosya olarak paylaşılsaydı, ürün değiştiğinde
          eskir ve eskidiğini kimse fark etmezdi.
        </p>
      </footer>
    </article>
  );
}
