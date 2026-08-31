import type { Metadata } from "next";
import { DetailHead, DetailNext } from "../../marketing/detail-shared.js";

export const metadata: Metadata = {
  title: "Mevzuat · KAELON",
  description:
    "TDHP, VUK amortismanı, 2026 bordrosu, e-Fatura ve İş Kanunu. " +
    "Ayar ekranında değil kodun içinde ve testli — işlenmiş örnekleriyle.",
};

/** Azalan bakiye: oran iki katı ama %50'yi geçemez, son yıl kalanın tamamı. */
const AMORT = [
  { yil: 2026, baslangic: 1_600_000, oran: "%25", ayrilan: 400_000, kalan: 1_200_000 },
  { yil: 2027, baslangic: 1_200_000, oran: "%25", ayrilan: 300_000, kalan: 900_000 },
  { yil: 2028, baslangic: 900_000, oran: "%25", ayrilan: 225_000, kalan: 675_000 },
  { yil: 2029, baslangic: 675_000, oran: "%25", ayrilan: 168_750, kalan: 506_250 },
  { yil: 2030, baslangic: 506_250, oran: "%25", ayrilan: 126_563, kalan: 379_687 },
  { yil: 2031, baslangic: 379_687, oran: "%25", ayrilan: 94_922, kalan: 284_765 },
  { yil: 2032, baslangic: 284_765, oran: "%25", ayrilan: 71_191, kalan: 213_574 },
  { yil: 2033, baslangic: 213_574, oran: "son yıl", ayrilan: 213_574, kalan: 0, son: true },
];

/** 2026 GİB tarifesi — kümülatif matrah büyüdükçe dilim yükselir. */
const DILIM = [
  { ust: "190.000 ₺", oran: "%15" },
  { ust: "400.000 ₺", oran: "%20" },
  { ust: "1.500.000 ₺", oran: "%27" },
  { ust: "5.300.000 ₺", oran: "%35" },
  { ust: "üstü", oran: "%40" },
];

const KURALLAR = [
  {
    n: "1xx–7xx",
    baslik: "Tek Düzen Hesap Planı",
    metin:
      "Mali müşavir, vergi dairesi ve bağımsız denetim bu kodları bekler. " +
      "Kendi hesap kodunuzu uydurmak, defterinizi sizden başka kimsenin " +
      "okuyamaması demektir.",
  },
  {
    n: "VUK 320",
    baslik: "Kıst amortisman",
    metin:
      "Binek otomobilde iktisap yılı için kalan ay kadar amortisman ayrılır; " +
      "ay kesri tam ay sayılır. 18 Nisan'da alınan araç için dokuz ay.",
  },
  {
    n: "UBL-TR 1.2",
    baslik: "e-Fatura ve e-İrsaliye",
    metin:
      "Belge standarda uygun üretilir. Gönderim entegratörün işidir ve bu " +
      "sistemde gönderim aracı yoktur — olduğunu söylemek yanlış olurdu.",
  },
  {
    n: "XBRL-GL",
    baslik: "e-Defter",
    metin:
      "Yevmiye ve defter-i kebir GİB'in beklediği biçimde üretilir. Berat " +
      "alma süreci mali müşavirin kendi aracıyla yürür.",
  },
  {
    n: "20 gün",
    baslik: "İş Kanunu 4857",
    metin:
      "Elli yaş üstü ve on sekiz yaş altı çalışana, kıdeminden bağımsız en " +
      "az yirmi gün yıllık izin. Kıdem hesabı bunu ezemez.",
  },
  {
    n: "28.075,50 ₺",
    baslik: "2026 net asgari ücret",
    metin:
      "Asgari ücret istisnası, SGK taban–tavan ve damga vergisi resmî " +
      "değerlerle. Bir parametre değiştiğinde tek yerden değişir.",
  },
];

export default function Page() {
  return (
    <section className="mk-sec">
      <DetailHead
        eyebrow="Mevzuat"
        title={
          <>
            Kural bir ayar değil.
            <br />
            <span className="dim">Testi olan bir kod.</span>
          </>
        }
        lede={
          "Çoğu ERP mevzuatı bir ayar ekranına koyar ve doğru doldurmayı size " +
          "bırakır. Burada kurallar kodun içinde ve her birinin testi var — " +
          "aşağıda ikisinin işlenmiş hâli."
        }
      />

      {/* ── Amortisman tablosu ── */}
      <article className="dt-block k-rise">
        <header>
          <span className="mk-kind">İŞLENMİŞ ÖRNEK</span>
          <h2>Azalan bakiyede %50 tavanı</h2>
          <p>
            1.600.000 ₺&apos;lik kaynak robotu, 8 yıl faydalı ömür. Normal oran
            %12,5; azalan bakiyede iki katı, yani %25.{" "}
            <strong>Yüzde elliyi geçemez</strong> — burada geçmiyor. Son yılda
            kalan bakiyenin tamamı yazılır, yoksa kıymet defterde sonsuza kadar
            küçülerek kalırdı.
          </p>
        </header>

        <div className="scroll-x">
          <table className="mv-table">
            <thead>
              <tr>
                <th>Yıl</th>
                <th>Dönem başı</th>
                <th>Oran</th>
                <th>Ayrılan</th>
                <th>Kalan</th>
              </tr>
            </thead>
            <tbody>
              {AMORT.map((r) => (
                <tr key={r.yil} className={r.son ? "last" : ""}>
                  <td>{r.yil}</td>
                  <td>{r.baslangic.toLocaleString("tr-TR")}</td>
                  <td>{r.oran}</td>
                  <td>{r.ayrilan.toLocaleString("tr-TR")}</td>
                  <td>{r.kalan.toLocaleString("tr-TR")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mk-mono">VUK 315 · AZALAN BAKİYELER USULÜ · TAVAN %50</p>
      </article>

      {/* ── Vergi dilimi ── */}
      <article className="dt-block k-rise">
        <header>
          <span className="mk-kind">İŞLENMİŞ ÖRNEK</span>
          <h2>Kümülatif matrah ve dilim</h2>
          <p>
            Gelir vergisi <strong>yıl içinde biriken</strong> matraha göre
            hesaplanır. Ocak&apos;ta %15&apos;ten kesilen bir çalışan Aralık&apos;ta
            %27&apos;ye gelmiş olabilir; net maaşı düşer. Bir ayı on iki ile
            çarpmak bu yüzden yanlış cevaptır.
          </p>
        </header>

        <div className="mv-brackets">
          {DILIM.map((d, i) => (
            <div key={d.ust} style={{ "--i": i } as React.CSSProperties}>
              <b>{d.oran}</b>
              <span>{d.ust === "üstü" ? "üstü" : `${d.ust}'ye kadar`}</span>
            </div>
          ))}
        </div>
        <p className="mk-mono">2026 GİB ÜCRET TARİFESİ · KAYNAKLI VE SÜRÜMLÜ</p>
      </article>

      {/* ── Kural listesi ── */}
      <article className="dt-block k-rise">
        <header>
          <span className="mk-kind">KAPSAM</span>
          <h2>Kodun içindeki kurallar</h2>
          <p>
            Hepsi testli. Bir parametre değiştiğinde tek yerden değişir ve
            değişiklik testte görünür.
          </p>
        </header>

        <div className="mk-law">
          {KURALLAR.map((k) => (
            <div key={k.n}>
              <span className="mk-law-n">{k.n}</span>
              <h3>{k.baslik}</h3>
              <p>{k.metin}</p>
            </div>
          ))}
        </div>
      </article>

      {/* ── Yapmadığımız ── */}
      <article className="dt-block k-rise">
        <header>
          <span className="mk-kind">YAPMADIĞIMIZ</span>
          <h2>Söylemediğimiz şeyler</h2>
          <p>
            Bir mevzuat listesinin en değerli kısmı, kapsamadığını da
            söylemesidir. Aşağıdakiler <strong>yok</strong> — ve olduğunu iddia
            etmek, ilk denetimde ortaya çıkacak bir yalan olurdu.
          </p>
        </header>

        <div className="dt-src">
          <div>
            <b>GÖNDERİM ARACI YOK</b>
            <span>
              e-Fatura ve e-İrsaliye üretilir; GİB&apos;e ya da entegratöre
              gönderim bu sistemde yapılmaz.
            </span>
          </div>
          <div>
            <b>BERAT ALINMAZ</b>
            <span>
              e-Defter dosyası üretilir; berat süreci mali müşavirin kendi
              aracıyla yürür.
            </span>
          </div>
          <div>
            <b>BEYANNAME VERİLMEZ</b>
            <span>
              KDV rakamları hesaplanır ve gösterilir; beyanname gönderimi
              yapılmaz.
            </span>
          </div>
          <div>
            <b>Ba/Bs YOK</b>
            <span>
              25 Eylül 2024&apos;te kaldırıldı. Kaldırılmış bir formu üretmek
              özellik değil, gürültüdür.
            </span>
          </div>
        </div>
      </article>

      <DetailNext current="/mevzuat" />
    </section>
  );
}
