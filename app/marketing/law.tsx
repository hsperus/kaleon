/**
 * Mevzuat — altı kural, her biri kodda ve testli.
 *
 * SAYI ÖNDE. Her hücre bir rakamla açılıyor: %50 tavan, VUK 320,
 * 28.075,50 ₺, 20 gün. Muhasebeci bu rakamları tanır; tanıdığı anda
 * "bu ürün benim işimi biliyor" der. Uzun cümle bunu yapamaz.
 *
 * SAÇ TELİ ARALIK: ızgara 1px boşlukla kuruluyor, arkadaki çizgi
 * rengi aralıklardan görünüyor. Altı ayrı kutu yerine tek bir tablo
 * gibi okunuyor — mevzuat da öyledir, dağınık değil bütündür.
 */
export function Law() {
  return (
    <section className="mk-sec">
      <span className="mk-anchor" id="mevzuat" />
      <p className="mk-eyebrow k-rise-sm">Mevzuat</p>
      <h2 className="mk-h2 k-rise">
        Yorumlanacak bir şey değil.
        <br />
        <span className="dim">Kodun içinde.</span>
      </h2>

      <div className="mk-law k-rise">
        <div>
          <span className="mk-law-n">1xx–7xx</span>
          <h3>Tek Düzen Hesap Planı</h3>
          <p>
            Mali müşavir, vergi dairesi ve bağımsız denetim bu kodları bekler.
          </p>
        </div>
        <div>
          <span className="mk-law-n">%50 tavan</span>
          <h3>VUK amortismanı</h3>
          <p>
            Azalan bakiyede oran iki katıdır ama yüzde elliyi geçemez. Son yıl
            kalanın tamamı yazılır.
          </p>
        </div>
        <div>
          <span className="mk-law-n">VUK 320</span>
          <h3>Kıst amortisman</h3>
          <p>
            Binek otomobilde iktisap yılı için kalan ay kadar; ay kesri tam ay
            sayılır.
          </p>
        </div>
        <div>
          <span className="mk-law-n">28.075,50 ₺</span>
          <h3>2026 bordrosu</h3>
          <p>
            Kümülatif matrah, SGK taban–tavan, asgari ücret istisnası — resmî
            tarifeye göre.
          </p>
        </div>
        <div>
          <span className="mk-law-n">UBL-TR 1.2</span>
          <h3>e-Fatura · e-İrsaliye</h3>
          <p>
            Belge üretilir; gönderim entegratörün işidir. Bu sistemde gönderim
            aracı yoktur.
          </p>
        </div>
        <div>
          <span className="mk-law-n">20 gün</span>
          <h3>İş Kanunu 4857</h3>
          <p>
            Elli yaş üstü ve on sekiz yaş altına kıdeminden bağımsız en az
            yirmi gün izin.
          </p>
        </div>
      </div>
      <a className="mk-more k-rise-sm" href="/mevzuat">
        Her kuralın işlenmiş örneğini gör <span aria-hidden>→</span>
      </a>

    </section>
  );
}
