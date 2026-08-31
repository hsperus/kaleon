"use client";

/**
 * Demo kayıt akışı.
 *
 * ÜÇ ADIM, TEK EKRAN. Tek uzun form korkutur; üç adım hem kısa görünür
 * hem de her adımın neden sorulduğunu anlatmaya yer bırakır. Adımlar
 * arasında geri gidilebilir ve girilenler korunur.
 *
 * HER ALANIN NİÇİN SORULDUĞU YAZIYOR. "Sektör" alanının yanında
 * "ürününüzün adları buna göre gelir" yazmazsak, kullanıcı bunu bir
 * pazarlama sorusu sanır ve rastgele seçer — sonra da ürünü kendi
 * işine benzemez bulur.
 *
 * KURULUM BEKLERKEN NE OLDUĞU ANLATILIR. Otuz göç ve veri tohumlama
 * saniyeler sürüyor; sessiz bir bekleme bozuk bir ürün izlenimi verir.
 * Adımlar sahte bir ilerleme çubuğu değil, gerçekten olan işler.
 */

import { useEffect, useRef, useState } from "react";

const SEKTORLER = [
  { id: "makina", label: "Makina ve metal işleme" },
  { id: "plastik", label: "Plastik ve kalıp" },
  { id: "tekstil", label: "Tekstil ve konfeksiyon" },
  { id: "gida", label: "Gıda üretimi" },
  { id: "kimya", label: "Kimya ve boya" },
  { id: "mobilya", label: "Mobilya ve ahşap" },
] as const;

const BANTLAR = ["1–10", "11–50", "51–150", "151–500", "500+"] as const;

/** Kurulum sırasında gösterilen adımlar — hepsi gerçekten oluyor. */
const KURULUM = [
  "Şirketiniz için ayrı bir veritabanı şeması açılıyor",
  "Otuz şema göçü uygulanıyor",
  "Hesap planı, depo ve ürün kartları kuruluyor",
  "Açılış bilançosu ve sabit kıymetler yazılıyor",
  "Sipariş → sevkiyat → fatura zinciri işletiliyor",
  "Sekiz aylık bordro hesaplanıyor",
];

const ONAY =
  "İletişim bilgilerimin KAELON demo talebimin değerlendirilmesi ve benimle " +
  "iletişime geçilmesi amacıyla işlenmesine onay veriyorum. Demo ortamı 14 gün " +
  "sonra silinir.";

export function DemoForm() {
  const [step, setStep] = useState(0);
  const [companyName, setCompanyName] = useState("");
  const [sector, setSector] = useState<string>("makina");
  const [employeeBand, setEmployeeBand] = useState<string>("11–50");
  const [goals, setGoals] = useState("");
  const [contactName, setContactName] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const firstField = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!busy) firstField.current?.focus();
  }, [step, busy]);

  /*
   * KURULUM ADIMLARI ZAMANA GÖRE İLERLER.
   *
   * Sunucu ara ilerleme bildirmiyor; tek bir istek var. Adımları
   * zamanla ilerletmek bir tahmindir ve öyle olduğu için de asla
   * "tamamlandı" demez — son adımda durur ve cevabı bekler.
   */
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => {
      setProgress((p) => Math.min(p + 1, KURULUM.length - 1));
    }, 2200);
    return () => clearInterval(t);
  }, [busy]);

  async function submit() {
    setBusy(true);
    setError(null);
    setProgress(0);
    try {
      const res = await fetch("/api/demo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyName,
          sector,
          employeeBand,
          goals,
          contactName,
          contactEmail,
          contactPhone: contactPhone.trim() || null,
          consent,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(body.error ?? "Demo ortamı kurulamadı.");
        setBusy(false);
        return;
      }
      // Oturum çerezi geldi; ürünün kendisine geçiliyor.
      window.location.href = "/uygulama";
    } catch {
      setError("Sunucuya ulaşılamadı. Bağlantınızı kontrol edip tekrar deneyin.");
      setBusy(false);
    }
  }

  const step0Ok = companyName.trim().length >= 2;
  const step1Ok = goals.trim().length >= 10;
  const step2Ok =
    contactName.trim().length >= 2 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(contactEmail.trim()) && consent;

  if (busy) {
    return (
      <div className="dm-wait">
        <p className="mk-eyebrow">Kuruluyor</p>
        <h2 className="mk-h2">
          {companyName} için
          <br />
          <span className="dim">gerçek bir ortam açılıyor.</span>
        </h2>
        <p className="mk-sub">
          Bu bir demo ekranı değil. Aşağıdakiler şu anda gerçekten oluyor;
          birkaç saniye sürüyor.
        </p>
        <ol className="dm-steps">
          {KURULUM.map((s, i) => (
            <li key={s} className={i < progress ? "done" : i === progress ? "on" : ""}>
              <span className="dot" aria-hidden />
              {s}
            </li>
          ))}
        </ol>
      </div>
    );
  }

  return (
    <div className="dm">
      <div className="dm-rail" aria-hidden>
        {["Şirket", "Öncelikler", "İletişim"].map((s, i) => (
          <span key={s} className={i === step ? "on" : i < step ? "done" : ""}>
            {s}
          </span>
        ))}
      </div>

      {step === 0 && (
        <div className="dm-step">
          <label className="dm-field">
            <span>Şirket adı</span>
            <input
              ref={firstField}
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
              placeholder="Örn. Yıldız Makina"
              maxLength={120}
            />
            <em>Faturaların anteti ve ajanın size sesleneceği ad bu olur.</em>
          </label>

          <div className="dm-field">
            <span>Ne üretiyorsunuz?</span>
            <div className="dm-chips">
              {SEKTORLER.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className={sector === s.id ? "on" : ""}
                  onClick={() => setSector(s.id)}
                >
                  {s.label}
                </button>
              ))}
            </div>
            <em>
              Ürün kartları, müşteri ve makine adları buna göre gelir — ekranda
              kendi işinizin kelimelerini görürsünüz.
            </em>
          </div>

          <div className="dm-field">
            <span>Kaç kişisiniz?</span>
            <div className="dm-chips">
              {BANTLAR.map((b) => (
                <button
                  key={b}
                  type="button"
                  className={employeeBand === b ? "on" : ""}
                  onClick={() => setEmployeeBand(b)}
                >
                  {b}
                </button>
              ))}
            </div>
          </div>

          <div className="dm-acts">
            <button
              type="button"
              className="mk-pill-lg mk-pill-blue"
              disabled={!step0Ok}
              onClick={() => setStep(1)}
            >
              Devam
            </button>
          </div>
        </div>
      )}

      {step === 1 && (
        <div className="dm-step">
          <label className="dm-field">
            <span>Bu ay sizi en çok ne uğraştırıyor?</span>
            <textarea
              value={goals}
              onChange={(e) => setGoals(e.target.value)}
              rows={5}
              maxLength={600}
              placeholder="Örn. İhracat faturalarında kur farkı takibi elle yapılıyor ve ay sonunda tutmuyor. Stok sayımı ile defter arasında sürekli fark çıkıyor."
            />
            <em>
              Ajan bunu okur ve neyi öne çıkaracağını buna göre seçer. Yetki
              vermez, hesap değiştirmez — yalnızca hangi rakamın sizin için
              önemli olduğunu bilir.
            </em>
          </label>

          <div className="dm-acts">
            <button type="button" className="mk-pill-ghost" onClick={() => setStep(0)}>
              Geri
            </button>
            <button
              type="button"
              className="mk-pill-lg mk-pill-blue"
              disabled={!step1Ok}
              onClick={() => setStep(2)}
            >
              Devam
            </button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="dm-step">
          <label className="dm-field">
            <span>Adınız</span>
            <input
              ref={firstField}
              value={contactName}
              onChange={(e) => setContactName(e.target.value)}
              maxLength={80}
            />
          </label>
          <label className="dm-field">
            <span>E-posta</span>
            <input
              type="email"
              value={contactEmail}
              onChange={(e) => setContactEmail(e.target.value)}
              placeholder="ad@sirket.com"
              maxLength={160}
            />
          </label>
          <label className="dm-field">
            <span>
              Telefon <i>isteğe bağlı</i>
            </span>
            <input
              value={contactPhone}
              onChange={(e) => setContactPhone(e.target.value)}
              placeholder="+90"
              maxLength={30}
            />
          </label>

          <label className="dm-consent">
            <input
              type="checkbox"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
            />
            <span>{ONAY}</span>
          </label>

          {error && <p className="dm-error">{error}</p>}

          <div className="dm-acts">
            <button type="button" className="mk-pill-ghost" onClick={() => setStep(1)}>
              Geri
            </button>
            <button
              type="button"
              className="mk-pill-lg mk-pill-blue"
              disabled={!step2Ok}
              onClick={() => void submit()}
            >
              Ortamı kur
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
