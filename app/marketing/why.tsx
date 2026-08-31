/**
 * "Neden Kaelon" — patron ve ekip için ayrı ayrı değil, birlikte.
 *
 * BAŞLIK BİR GERİLİMİ ÇÖZÜYOR. Bir ERP genellikle ikisinden birini
 * memnun eder: patron rapor alır ama ekip form doldurmaktan bıkar,
 * ya da ekip hızlı çalışır ama patron ne olup bittiğini göremez.
 * "Patron her şeye hakim / Ekip her şeyden hızlı" ikisinin aynı anda
 * mümkün olduğunu iddia ediyor — ve altındaki üç sütun bunun nasıl
 * olduğunu söylüyor.
 *
 * ÜÇÜNCÜ SÜTUN VAAT DEĞİL SINIR: "veri yoksa sayı uydurulmaz."
 * Vitrinde bir şeyi YAPAMADIĞINI söylemek alışılmış değil ama bu
 * üründe en çok güven veren cümle o — çünkü rakamı imzalayacak olan
 * kullanıcı.
 */

const SUTUNLAR = [
  {
    baslik: "Tek bakışta bütün şirket",
    metin:
      "Nakit, üretim, stok, bordro — rapor beklemeden, ekran gezmeden. " +
      "Her rakam tek sorunun uzağında.",
  },
  {
    baslik: "Veri girişi saniyeler sürer",
    metin:
      "“200 adet mil sevk ettik” yazmak yeterli; irsaliye, stok ve cari " +
      "kaydı hazır gelir. Form doldurmak yok.",
  },
  {
    baslik: "Kontrol hep sizde",
    metin:
      "Yazan her işlem onayınızdan geçer, her cevabın kaynağı izlenebilir. " +
      "Veri yoksa sayı uydurulmaz.",
  },
];

export function Why() {
  return (
    <section id="guven" className="v-sec">
      <h2 className="v-h2">
        Patron her şeye hakim.
        <br />
        <span className="dim">Ekip her şeyden hızlı.</span>
      </h2>

      <div className="v-cols">
        {SUTUNLAR.map((s, i) => (
          <div key={s.baslik} className="v-col" style={{ animationDelay: `${i * 0.07}s` }}>
            <h3>{s.baslik}</h3>
            <p>{s.metin}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * Kapanış çağrısı.
 *
 * TEK CÜMLE, TEK DÜĞME. Buraya kadar okuyan kişi ikna olmuştur ya da
 * olmamıştır; üçüncü bir argüman eklemek kararı geciktirir. Düğme
 * beyaz: sayfadaki tek beyaz zemin olduğu için gözün gittiği son yer.
 */
export function Cta() {
  return (
    <section className="v-cta">
      <h2 className="v-h2 center">Sormaya başlayın.</h2>
      <div className="v-cta-acts">
        <a className="v-btn light" href="/uygulama">
          Sisteme girin
        </a>
      </div>
    </section>
  );
}
