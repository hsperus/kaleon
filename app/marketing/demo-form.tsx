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

/** Ciro bandı — açılış bilançosunun ölçeğini belirler. */
const CIROLAR = [
  { id: "0-10m", label: "10 milyon ₺ altı" },
  { id: "10-50m", label: "10–50 milyon ₺" },
  { id: "50-250m", label: "50–250 milyon ₺" },
  { id: "250m-1mr", label: "250 milyon – 1 milyar ₺" },
  { id: "1mr+", label: "1 milyar ₺ üstü" },
] as const;

/** İhracat — dövizli alacak ve kur değerlemesi yalnızca burada kurulur. */
const IHRACAT = [
  { id: "yok", label: "İhracat yapmıyoruz" },
  { id: "EUR", label: "Euro ile ihracat" },
  { id: "USD", label: "Dolar ile ihracat" },
] as const;

/** Şu an ne kullanıyor — ajanın cevabını hangi dile çevireceğini belirler. */
const SISTEMLER = [
  { id: "excel", label: "Excel" },
  { id: "logo", label: "Logo" },
  { id: "mikro", label: "Mikro" },
  { id: "netsis", label: "Netsis" },
  { id: "sap", label: "SAP" },
  { id: "diger", label: "Başka / yok" },
] as const;

/** Kurulum sırasında gösterilen adımlar — hepsi gerçekten oluyor. */
const KURULUM = [
  "Şirketiniz için ayrı bir veritabanı şeması açılıyor",
  "Otuz şema göçü uygulanıyor",
  "Tek Düzen Hesap Planı, depo ve ürün kartları kuruluyor",
  "Açılış bilançosu ve sabit kıymetler yazılıyor",
  "Sipariş → sevkiyat → fatura zinciri işletiliyor",
  "Amortisman ve sekiz aylık bordro hesaplanıyor",
];

const ONAY =
  "İletişim bilgilerimin KAELON demo talebimin değerlendirilmesi ve benimle " +
  "iletişime geçilmesi amacıyla işlenmesine onay veriyorum. Demo ortamı 14 gün " +
  "sonra silinir.";

export function DemoForm() {
  const [step, setStep] = useState(0);
  const [companyName, setCompanyName] = useState("");
  const [legalName, setLegalName] = useState("");
  const [taxId, setTaxId] = useState("");
  const [taxOffice, setTaxOffice] = useState("");
  const [city, setCity] = useState("");
  const [sector, setSector] = useState<string>("makina");
  const [employeeBand, setEmployeeBand] = useState<string>("11–50");
  const [revenueBand, setRevenueBand] = useState<string>("50-250m");
  const [exportCurrency, setExportCurrency] = useState<string>("yok");
  const [currentSystem, setCurrentSystem] = useState<string>("excel");
  const [goals, setGoals] = useState("");
  const [contactName, setContactName] = useState("");
  const [contactTitle, setContactTitle] = useState("");
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
          legalName: legalName.trim() || null,
          taxId: taxId.trim() || null,
          taxOffice: taxOffice.trim() || null,
          city: city.trim() || null,
          sector,
          employeeBand,
          revenueBand,
          exportCurrency,
          currentSystem,
          goals,
          contactName,
          contactTitle: contactTitle.trim() || null,
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

  /*
   * VKN ON HANE, TCKN ON BİR. İkisi de kabul edilir çünkü şahıs
   * şirketleri TCKN ile fatura keser. BOŞ BIRAKILABİLİR: demo bu alan
   * olmadan da çalışır, yalnızca faturada örnek değer görünür.
   */
  const vknGecerli = taxId.trim() === "" || /^\d{10,11}$/.test(taxId.trim());

  const step0Ok = companyName.trim().length >= 2 && vknGecerli;
  const step1Ok = true;
  const step2Ok = goals.trim().length >= 10;
  const step3Ok =
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
          {exportCurrency !== "yok" &&
            ` İhracat yaptığınız için ${exportCurrency} cinsinden açık bir alacak da kuruluyor.`}
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
        {["Şirket", "İşin şekli", "Öncelikler", "İletişim"].map((s, i) => (
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
              maxLength={120}
            />
            <em>Ajanın size sesleneceği ve ekranda göreceğiniz ad.</em>
          </label>

          <label className="dm-field">
            <span>
              Ticari unvan <i>isteğe bağlı</i>
            </span>
            <input value={legalName} onChange={(e) => setLegalName(e.target.value)} maxLength={160} />
            <em>
              Faturanın antetinde bu yazar. Boş bırakırsanız şirket adından
              türetilir.
            </em>
          </label>

          <div className="dm-row">
            <label className="dm-field">
              <span>
                Vergi / TC kimlik no <i>isteğe bağlı</i>
              </span>
              <input
                inputMode="numeric"
                value={taxId}
                onChange={(e) => setTaxId(e.target.value.replace(/\D/g, ""))}
                maxLength={11}
                aria-invalid={!vknGecerli}
              />
              <em>
                {vknGecerli
                  ? "e-Faturanın zorunlu alanı: 10 hane VKN ya da 11 hane TCKN."
                  : "10 hane (VKN) ya da 11 hane (TCKN) olmalı."}
              </em>
            </label>

            <label className="dm-field">
              <span>
                Vergi dairesi <i>isteğe bağlı</i>
              </span>
              <input value={taxOffice} onChange={(e) => setTaxOffice(e.target.value)} maxLength={60} />
              <em>Faturada ve e-Defterde görünür.</em>
            </label>
          </div>

          <label className="dm-field">
            <span>
              Şehir <i>isteğe bağlı</i>
            </span>
            <input value={city} onChange={(e) => setCity(e.target.value)} maxLength={40} />
            <em>Şirket adresi olarak kullanılır.</em>
          </label>

          <div className="dm-field">
            <span>Ne üretiyorsunuz?</span>
            <div className="dm-chips">
              {SEKTORLER.map((x) => (
                <button
                  key={x.id}
                  type="button"
                  className={sector === x.id ? "on" : ""}
                  onClick={() => setSector(x.id)}
                >
                  {x.label}
                </button>
              ))}
            </div>
            <em>
              Ürün kartları, müşteri ve makine adları buna göre gelir — ekranda
              kendi işinizin kelimelerini görürsünüz.
            </em>
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

          <div className="dm-field">
            <span>Yıllık cironuz hangi bantta?</span>
            <div className="dm-chips">
              {CIROLAR.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className={revenueBand === c.id ? "on" : ""}
                  onClick={() => setRevenueBand(c.id)}
                >
                  {c.label}
                </button>
              ))}
            </div>
            <em>
              Açılış bilançosunun ölçeği buna göre kurulur. Beş kişilik bir
              atölyeye 19 milyonluk sermaye göstermek, ürünün sizin ölçeğinizi
              bilmediğini söyler.
            </em>
          </div>

          <div className="dm-field">
            <span>İhracat yapıyor musunuz?</span>
            <div className="dm-chips">
              {IHRACAT.map((x) => (
                <button
                  key={x.id}
                  type="button"
                  className={exportCurrency === x.id ? "on" : ""}
                  onClick={() => setExportCurrency(x.id)}
                >
                  {x.label}
                </button>
              ))}
            </div>
            <em>
              {exportCurrency === "yok"
                ? "İç piyasaya satan bir firmaya dövizli alacak göstermeyiz; kur riski sizin sorununuz değil."
                : "Dövizli bir alacak ve dönem sonu kur değerlemesi (VUK 280) kurulur — kur farkınızı sorabilirsiniz."}
            </em>
          </div>

          <div className="dm-field">
            <span>Şu an ne kullanıyorsunuz?</span>
            <div className="dm-chips">
              {SISTEMLER.map((x) => (
                <button
                  key={x.id}
                  type="button"
                  className={currentSystem === x.id ? "on" : ""}
                  onClick={() => setCurrentSystem(x.id)}
                >
                  {x.label}
                </button>
              ))}
            </div>
            <em>
              Ajan cevabını buna göre çevirir: SAP&apos;den geçen birine
              &ldquo;bunun SAP&apos;deki karşılığı&rdquo; demek işe yarar,
              Excel&apos;den gelene aynı cümle bir şey ifade etmez.
            </em>
          </div>

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
            <span>Bu ay sizi en çok ne uğraştırıyor?</span>
            <textarea
              value={goals}
              onChange={(e) => setGoals(e.target.value)}
              rows={5}
              maxLength={600}
            />
            <em>
              Ajan bunu okur ve neyi öne çıkaracağını buna göre seçer. Yetki
              vermez, hesap değiştirmez — yalnızca hangi rakamın sizin için
              önemli olduğunu bilir. En az on karakter.
            </em>
          </label>

          <div className="dm-acts">
            <button type="button" className="mk-pill-ghost" onClick={() => setStep(1)}>
              Geri
            </button>
            <button
              type="button"
              className="mk-pill-lg mk-pill-blue"
              disabled={!step2Ok}
              onClick={() => setStep(3)}
            >
              Devam
            </button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="dm-step">
          <div className="dm-row">
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
              <span>
                Göreviniz <i>isteğe bağlı</i>
              </span>
              <input
                value={contactTitle}
                onChange={(e) => setContactTitle(e.target.value)}
                maxLength={60}
              />
            </label>
          </div>

          <label className="dm-field">
            <span>E-posta</span>
            <input
              type="email"
              value={contactEmail}
              onChange={(e) => setContactEmail(e.target.value)}
              maxLength={160}
            />
            <em>Ortamınıza yeniden girmek için bu adresi kullanırsınız.</em>
          </label>

          <label className="dm-field">
            <span>
              Telefon <i>isteğe bağlı</i>
            </span>
            <input
              inputMode="tel"
              value={contactPhone}
              onChange={(e) => setContactPhone(e.target.value)}
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
            <button type="button" className="mk-pill-ghost" onClick={() => setStep(2)}>
              Geri
            </button>
            <button
              type="button"
              className="mk-pill-lg mk-pill-blue"
              disabled={!step3Ok}
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
