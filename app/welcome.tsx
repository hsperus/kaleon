"use client";

/**
 * İlk giriş karşılaması.
 *
 * NEDEN VAR: giriş yapan kişi boş bir sohbet kutusuyla karşılaşıyordu.
 * Ürün "menü yok, Türkçe sorun" diyor ama bunu ilk anda kimse
 * söylemiyordu; kullanıcı ne sorabileceğini, cevabın nasıl geleceğini
 * ve yazan işlemlerin neden durduğunu bilmeden başlıyordu.
 *
 * DÖRT EKRAN, HEPSİ GÖSTEREREK. Metin yerine küçük bir canlandırma
 * var: soru yazılıyor, cevap tablo olarak geliyor, onay formu beliriyor,
 * rol kartları filtreleniyor. "Anlatmak" yerine "göstermek", çünkü
 * ürünün iddiası zaten bu.
 *
 * KAPATMAK HER ZAMAN MÜMKÜN. Zorunlu bir turnike, ürünü denemeye gelen
 * kişiyi ilk otuz saniyede kaybettirir. "Geç" düğmesi her adımda duruyor.
 *
 * KAPATMA CİHAZ BAŞINA HATIRLANIR, hesap başına değil. Yeni bir
 * cihazdan giren kişi karşılamayı yeniden görür — çünkü orada da ilk
 * kez bakıyor ve klavyeden ekrana kadar her şey farklı. Sunucuda
 * saklansaydı ikinci cihazda hiç görünmezdi.
 *
 * `localStorage` erişimi TRY İÇİNDE: gizli sekmede ve depolamayı
 * kapatan tarayıcılarda okumak istisna fırlatır. O durumda karşılama
 * her açılışta çıkar — sinir bozucu ama uygulamayı çökertmez.
 */

const ANAHTAR = "kaelon.karsilama.v1";

export function karsilamaGorulduMu(): boolean {
  try {
    return localStorage.getItem(ANAHTAR) === "1";
  } catch {
    return false;
  }
}

export function karsilamaGoruldu(): void {
  try {
    localStorage.setItem(ANAHTAR, "1");
  } catch {
    // Depolama kapalı; karşılama bir daha çıkacak. Kabul.
  }
}

import { useEffect, useState } from "react";

interface Adim {
  readonly kicker: string;
  readonly baslik: string;
  readonly metin: string;
  readonly gorsel: "soru" | "cevap" | "onay" | "rol";
}

const ADIMLAR: readonly Adim[] = [
  {
    kicker: "1 / 4",
    baslik: "Menü yok. Sorun.",
    metin:
      "Aradığınız ekranı bulmanız gerekmiyor. Ne öğrenmek istiyorsanız " +
      "Türkçe yazın — hangi modülde olduğunu sistem bulur.",
    gorsel: "soru",
  },
  {
    kicker: "2 / 4",
    baslik: "Cevap bakılacak bir şeydir.",
    metin:
      "Soruya göre bir tablo, bir grafik, bir belge ya da onaylamanız " +
      "gereken bir form gelir. Altında hep aynı satır durur: rakam nereden " +
      "geldi ve ne kadar güveniliyor.",
    gorsel: "cevap",
  },
  {
    kicker: "3 / 4",
    baslik: "Yazan hiçbir işlem tek başına çalışmaz.",
    metin:
      "141 işin 77'si veri yazar. Hepsi alanları doldurulmuş bir formla " +
      "önünüze gelir; siz onaylamadan kayıt oluşmaz. Yapay zekâ hazırlar, " +
      "sistem doğrular, insan onaylar.",
    gorsel: "onay",
  },
  {
    kicker: "4 / 4",
    baslik: "Herkes kendi işini görür.",
    metin:
      "Rolünüzün yetkisi olmayan araç modele hiç gönderilmez. Depo " +
      "sorumlusuna maaş sorulduğunda cevap 'yetkiniz yok' olur — çünkü " +
      "bakacak bir yer yoktur.",
    gorsel: "rol",
  },
];

const ROLLER = [
  { ad: "Patron", n: 141, w: 100 },
  { ad: "CFO", n: 83, w: 59 },
  { ad: "Depo", n: 36, w: 26 },
  { ad: "Operatör", n: 15, w: 11 },
];

function Gorsel({ tip }: { tip: Adim["gorsel"] }) {
  if (tip === "soru") {
    return (
      <div className="wc-art wc-ask">
        <span className="wc-caret">Bu ay kâr ettik mi?</span>
        <div className="wc-chips">
          <span>gelir tablosu</span>
          <span>3 hesap grubu</span>
          <span>ağustos</span>
        </div>
      </div>
    );
  }
  if (tip === "cevap") {
    return (
      <div className="wc-art wc-answer">
        <p>
          <b>379.610 ₺ brüt kâr</b> ettiniz ama dönem{" "}
          <b className="bad">601.890 ₺ zararla</b> kapanıyor.
        </p>
        <table>
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
              <td>-601.890</td>
            </tr>
          </tbody>
        </table>
        <span className="wc-src">YEVMİYE DEFTERİ · 17 FİŞ · GÜVEN 0.96</span>
      </div>
    );
  }
  if (tip === "onay") {
    return (
      <div className="wc-art wc-approve">
        <span className="wc-wait">ONAYINIZI BEKLİYOR</span>
        <h4>Satış faturası kesilecek</h4>
        <dl>
          <div>
            <dt>Müşteri</dt>
            <dd>Daimler Truck Otomotiv A.Ş.</dd>
          </div>
          <div>
            <dt>Tutar</dt>
            <dd>444.816,00 ₺</dd>
          </div>
        </dl>
        <div className="wc-acts">
          <span className="no">Vazgeç</span>
          <span className="yes">Onayla</span>
        </div>
      </div>
    );
  }
  return (
    <div className="wc-art wc-roles">
      {ROLLER.map((r, i) => (
        <div key={r.ad} style={{ animationDelay: `${0.12 + i * 0.09}s` }}>
          <span>{r.ad}</span>
          <i style={{ width: `${r.w}%` }} />
          <b>{r.n}</b>
        </div>
      ))}
    </div>
  );
}

export function Welcome({ name, onDone }: { name: string; onDone: () => void }) {
  const [i, setI] = useState(0);
  const son = i === ADIMLAR.length - 1;
  const adim = ADIMLAR[i]!;

  // Klavyeyle gezinme: ok tuşları ilerletir, Esc kapatır.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onDone();
      else if (e.key === "ArrowRight") setI((v) => Math.min(v + 1, ADIMLAR.length - 1));
      else if (e.key === "ArrowLeft") setI((v) => Math.max(v - 1, 0));
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDone]);

  const ilkAd = name.trim().split(/\s+/).find((w) => /^\p{L}/u.test(w)) ?? name;

  return (
    <div className="wc" role="dialog" aria-modal="true" aria-label="Hoş geldiniz">
      <div className="wc-card">
        <header>
          <span className="wc-kicker">{adim.kicker}</span>
          <button type="button" className="wc-skip" onClick={onDone}>
            Geç
          </button>
        </header>

        {/* Her adımda `key` değişiyor: React öğeyi yeniden kuruyor ve
            giriş animasyonu baştan oynuyor. Aynı öğe kalsaydı içerik
            değişir ama hareket olmazdı. */}
        <div className="wc-body" key={i}>
          <Gorsel tip={adim.gorsel} />
          <div className="wc-text">
            <h2>{i === 0 ? `Hoş geldiniz, ${ilkAd}.` : adim.baslik}</h2>
            {i === 0 && <p className="wc-sub">{adim.baslik}</p>}
            <p>{adim.metin}</p>
          </div>
        </div>

        <footer>
          <div className="wc-dots" aria-hidden>
            {ADIMLAR.map((a, n) => (
              <span key={a.kicker} className={n === i ? "on" : n < i ? "done" : ""} />
            ))}
          </div>
          <div className="wc-nav">
            {i > 0 && (
              <button type="button" className="wc-back" onClick={() => setI(i - 1)}>
                Geri
              </button>
            )}
            <button
              type="button"
              className="wc-next"
              onClick={() => (son ? onDone() : setI(i + 1))}
            >
              {son ? "Başlayalım" : "Devam"}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
