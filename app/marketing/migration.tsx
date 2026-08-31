/**
 * "Geçiş" bölümü.
 *
 * ERP DEĞİŞTİRMENİN GERÇEK ENGELİ YAZILIM DEĞİL, VERİDİR. Karar veren
 * kişi ürünü beğenir, sonra "ama bizim on beş yıllık cari listemiz
 * Logo'da" der ve konuşma orada biter. Bu bölüm o cümlenin cevabı.
 *
 * SAYILAR GERÇEK VE SAYILABİLİR. Altı şablon `src/modules/import/
 * objects.ts` içinde tanımlı, kırk sütun eşanlamlısı orada yazılı.
 * Uydurma bir "kolayca aktarın" cümlesi yerine ölçülebilir bir iddia
 * koyuyoruz — çünkü ölçülemeyen iddiaya kimse inanmaz.
 */
export function Migration() {
  return (
    <section className="mk-sec">
      <span className="mk-anchor" id="gecis" />
      <p className="mk-eyebrow k-rise-sm">Geçiş</p>
      <h2 className="mk-h2 k-rise">
        Excel’den de olur,
        <br />
        <span className="dim">SAP’ten de.</span>
      </h2>
      <p className="mk-sub k-rise-sm">
        ERP değiştirmenin gerçek engeli yazılım değil, veridir. Elinizdeki
        dosyayı olduğu gibi verin — sütun adlarını düzeltmeniz gerekmiyor.
      </p>

      <div className="mg k-rise">
        <div className="mg-flow">
          <div className="mg-step">
            <span className="mg-n">1</span>
            <h3>Dosyayı bırakın</h3>
            <p>
              Excel ya da CSV. Logo, Mikro, Netsis veya SAP’ten aldığınız
              dökümü değiştirmeden verin.
            </p>
          </div>
          <div className="mg-step">
            <span className="mg-n">2</span>
            <h3>Sütunlar tanınır</h3>
            <p>
              &ldquo;Unvan&rdquo;, &ldquo;firma adı&rdquo;, &ldquo;cari
              adı&rdquo; ya da &ldquo;name&rdquo; — hepsi aynı alana bağlanır.
              Kırk sütun karşılığı tanımlı.
            </p>
          </div>
          <div className="mg-step">
            <span className="mg-n">3</span>
            <h3>Önce görürsünüz</h3>
            <p>
              Kaç satır yazılacak, kaçı reddedilecek ve neden — hepsi
              yazılmadan ÖNCE. Onaylamazsanız hiçbir kayıt oluşmaz.
            </p>
          </div>
        </div>

        <div className="mg-facts">
          <div>
            <b>6</b>
            <span>hazır şablon: cari, malzeme, personel, puantaj, sipariş, banka bakiyesi</span>
          </div>
          <div>
            <b>40</b>
            <span>sütun karşılığı — dosyanızı yeniden biçimlendirmeniz gerekmiyor</span>
          </div>
          <div>
            <b>3.999<span className="mg-slash">/4.000</span></b>
            <span>
              Bir satır patlarsa dosya durmaz. Yazılabilenler yazılır, hatalı
              satır sebebiyle listelenir.
            </span>
          </div>
          <div>
            <b>0</b>
            <span>
              mükerrer kayıt. Aynı dosyayı iki kez yüklemek —&nbsp;ki herkes
              yükler&nbsp;— hiçbir şeyi ikiye katlamaz.
            </span>
          </div>
        </div>

        {/* Uydurma cari açmamak bir ÖZELLİK değil, bir SÖZ. */}
        <p className="mg-note">
          Bağlanamayan satır reddedilir; uydurma bir cari ya da personel
          <strong> açılmaz</strong>. Yoksa her hatalı dosya ana veriyi çöple
          doldurur ve altı ay sonra kimse hangi kaydın gerçek olduğunu bilemez.
        </p>
      </div>
      <a className="mk-more k-rise-sm" href="/gecis">
        Geçiş akışını adım adım gör <span aria-hidden>→</span>
      </a>

    </section>
  );
}
