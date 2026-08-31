import type { Metadata } from "next";
import { DetailHead, DetailNext } from "../../marketing/detail-shared.js";

export const metadata: Metadata = {
  title: "Geçiş · KAELON",
  description:
    "Excel, Logo, Mikro, Netsis ya da SAP'ten taşıma. Sütun adlarını " +
    "düzeltmeniz gerekmiyor; yazılmadan önce ne olacağını görüyorsunuz.",
};

/** Kullanıcının dosyasında olabilecek sütun adları — hepsi tanınır. */
const ESLESME = [
  { alan: "Unvan", zorunlu: true, karsilik: ["unvan", "ünvanı", "ticari unvan", "firma", "firma adı", "cari adı", "name"] },
  { alan: "Cari kodu", zorunlu: false, karsilik: ["cari kodu", "cari kod", "kod", "code", "müşteri kodu", "tedarikçi kodu"] },
  { alan: "Vergi no", zorunlu: false, karsilik: ["vkn", "vergi no", "vergi kimlik no", "tckn", "tc kimlik", "tax id"] },
  { alan: "Tür", zorunlu: false, karsilik: ["tür", "tip", "cari türü", "type"] },
];

const SABLONLAR = [
  { ad: "Cari listesi", not: "Müşteri ve tedarikçiler, vergi numaralarıyla" },
  { ad: "Malzeme listesi", not: "Ürün kartları, birim ve tür" },
  { ad: "Personel listesi", not: "Çalışanlar, departman, brüt ücret" },
  { ad: "Puantaj (PDKS)", not: "Giriş–çıkış kayıtları, bordroya bağlanır" },
  { ad: "Satış siparişleri", not: "Açık siparişler ve taahhüt tarihleri" },
  { ad: "Banka bakiyeleri", not: "Hesap bazında anlık bakiye" },
];

/** Önizleme tablosu — kabul ve ret satırları birlikte. */
const ONIZLEME = [
  { no: 1, unvan: "Daimler Truck Otomotiv Sanayi A.Ş.", vkn: "2960033525", durum: "yeni" },
  { no: 2, unvan: "Marmara Sanayi Ticaret A.Ş.", vkn: "4445556667", durum: "yeni" },
  { no: 3, unvan: "Anadolu Tedarik Sanayi Ltd. Şti.", vkn: "1112223334", durum: "güncellenecek" },
  { no: 4, unvan: "", vkn: "8887776665", durum: "ret" },
  { no: 5, unvan: "Ege Kalıp San. Tic. A.Ş.", vkn: "123", durum: "ret" },
];

export default function Page() {
  return (
    <section className="mk-sec">
      <DetailHead
        eyebrow="Geçiş"
        title={
          <>
            Dosyanızı düzeltmeyin.
            <br />
            <span className="dim">Olduğu gibi verin.</span>
          </>
        }
        lede={
          "ERP değiştirmenin gerçek engeli yazılım değil, veridir. On beş yıllık " +
          "cari listeniz Logo'daysa konuşma çoğu zaman orada biter. Bu sayfa o " +
          "cümlenin cevabı — ve iddiaların hepsi sayılabilir."
        }
      />

      {/* ── 1. Sütun eşleştirme ── */}
      <article className="dt-block k-rise">
        <header>
          <span className="mk-kind">ADIM 1</span>
          <h2>Sütun adları tanınır</h2>
          <p>
            Her alanın kaç farklı yazılışı olabileceği önceden tanımlı. Sizin
            &ldquo;firma adı&rdquo; yazdığınız sütunla bizim &ldquo;unvan&rdquo;
            dediğimiz alan aynı şeydir; bunu sizin bilmeniz gerekmez.
          </p>
        </header>

        <div className="gc-map">
          {ESLESME.map((e) => (
            <div key={e.alan}>
              <div className="gc-map-k">
                {e.alan}
                {e.zorunlu && <em>zorunlu</em>}
              </div>
              <div className="gc-map-v">
                {e.karsilik.map((k) => (
                  <span key={k}>{k}</span>
                ))}
              </div>
            </div>
          ))}
        </div>
        <p className="mk-mono">TOPLAM 40 SÜTUN KARŞILIĞI · 6 ŞABLONDA</p>
      </article>

      {/* ── 2. Önizleme ── */}
      <article className="dt-block k-rise">
        <header>
          <span className="mk-kind">ADIM 2</span>
          <h2>Yazılmadan önce görürsünüz</h2>
          <p>
            Kaç satır yeni açılacak, kaçı güncellenecek, kaçı reddedilecek ve{" "}
            <strong>neden</strong> — hepsi tek ekranda. Onaylamazsanız hiçbir
            kayıt oluşmaz.
          </p>
        </header>

        <div className="gc-preview">
          <div className="gc-preview-head">
            <span>cari-listesi-2026.xlsx · 4.000 satır</span>
            <span className="mk-wait">ONAYINIZI BEKLİYOR</span>
          </div>
          <div className="scroll-x">
            <table className="gc-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Unvan</th>
                  <th>Vergi no</th>
                  <th>Sonuç</th>
                </tr>
              </thead>
              <tbody>
                {ONIZLEME.map((r) => (
                  <tr key={r.no} className={r.durum === "ret" ? "bad" : ""}>
                    <td>{r.no}</td>
                    <td>{r.unvan || <em>boş</em>}</td>
                    <td>{r.vkn}</td>
                    <td>
                      {r.durum === "yeni" && <span className="gc-tag new">yeni açılacak</span>}
                      {r.durum === "güncellenecek" && (
                        <span className="gc-tag upd">güncellenecek</span>
                      )}
                      {r.durum === "ret" && (
                        <span className="gc-tag bad">
                          {r.unvan ? "vergi no 10 hane değil" : "unvan boş"}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
                <tr className="rest">
                  <td colSpan={4}>… 3.995 satır daha</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div className="gc-preview-foot">
            <span>
              <b>3.912</b> yeni
            </span>
            <span>
              <b>87</b> güncellenecek
            </span>
            <span className="bad">
              <b>1</b> reddedilecek
            </span>
          </div>
        </div>
      </article>

      {/* ── 3. Şablonlar ── */}
      <article className="dt-block k-rise">
        <header>
          <span className="mk-kind">ADIM 3</span>
          <h2>Altı şablon</h2>
          <p>
            Bir imalatçının taşımak isteyeceği her şey. Sipariş ve puantaj
            dosyaları sistemdeki kayıtlara <strong>bağlanır</strong>: bağlanamayan
            satır reddedilir, uydurma bir cari ya da personel açılmaz.
          </p>
        </header>

        <div className="gc-tpl">
          {SABLONLAR.map((s) => (
            <div key={s.ad}>
              <b>{s.ad}</b>
              <span>{s.not}</span>
            </div>
          ))}
        </div>
      </article>

      {/* ── 4. Güvenceler ── */}
      <article className="dt-block k-rise">
        <header>
          <span className="mk-kind">DÖRT GÜVENCE</span>
          <h2>Yükleme sizi cezalandırmaz</h2>
          <p>
            Veri taşımanın kötü hatıraları hep aynı üç şeyden gelir: mükerrer
            kayıt, tek hücre yüzünden baştan başlama, ve ana verinin çöple
            dolması.
          </p>
        </header>

        <div className="dt-src">
          <div>
            <b>MÜKERRER YOK</b>
            <span>
              Aynı dosyayı iki kez yüklemek — ki herkes yükler — hiçbir şeyi
              ikiye katlamaz.
            </span>
          </div>
          <div>
            <b>SATIR SATIR</b>
            <span>
              4.000 satırın 3.999&apos;u yazılabiliyorsa yazılır. Hatalı satır
              sebebiyle listelenir.
            </span>
          </div>
          <div>
            <b>UYDURMA KAYIT YOK</b>
            <span>
              Bağlanamayan satır reddedilir; olmayan bir cari ya da personel
              açılmaz.
            </span>
          </div>
          <div>
            <b>GERİ ALINABİLİR</b>
            <span>
              Her içe aktarma kendi kaydını bırakır: ne zaman, kim, hangi
              dosya, kaç satır.
            </span>
          </div>
        </div>
      </article>

      <DetailNext current="/gecis" />
    </section>
  );
}
