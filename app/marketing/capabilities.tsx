"use client";

/**
 * Ne yapar sayfası.
 *
 * TOOL ADI GÖSTERİLMEZ. Önceki hâlinde her yeteneğin yanında
 * `list_watchable_fields` gibi iç isimler duruyordu; ziyaretçiye
 * hiçbir şey anlatmadıkları gibi ürünü teknik ve karmaşık
 * gösteriyorlardı. Anlatan şey, sistemin o soruya NE İLE cevap
 * verdiğidir: belge mi, tablo mu, grafik mi, onay formu mu.
 */

import { useState } from "react";
import { RichText } from "../rich-text.js";
import { PageHead, Reveal, useReveal } from "./shell.js";

const ASSET_TABLE = `| Kıymet | Maliyet | Birikmiş | Net değer |
| --- | --- | --- | --- |
| CNC Torna Tezgahı | 2.400.000 | 240.000 | 2.160.000 |
| Kaynak Robotu | 1.600.000 | 400.000 | 1.200.000 |
| Ford Transit | 1.850.000 | 277.500 | 1.572.500 |
| Ofis Mobilyası | 320.000 | 64.000 | 256.000 |`;

const MONTHS = [100_974, 100_974, 100_974, 91_107, 91_107, 91_107, 88_608, 88_608, 88_608, 86_120, 86_120, 86_120];

function Chart({ on }: { on: boolean }) {
  const max = Math.max(...MONTHS);
  const min = Math.min(...MONTHS);
  return (
    <div className="cp-chart">
      <div className="cp-bars">
        {MONTHS.map((v, i) => (
          <i
            key={i}
            style={{
              height: on ? `${34 + ((v - min) / (max - min || 1)) * 66}%` : "0%",
              transitionDelay: `${i * 50}ms`,
            }}
          />
        ))}
      </div>
      <div className="cp-axis">
        <span>Ocak · {MONTHS[0]!.toLocaleString("tr-TR")} ₺ net</span>
        <span>Aralık · {MONTHS[11]!.toLocaleString("tr-TR")} ₺ net</span>
      </div>
    </div>
  );
}

function Doc() {
  const rows = [
    ["Hazır Değerler", "10.800.000", "Ticari Borçlar", "2.900.000"],
    ["Ticari Alacaklar", "444.816", "Ödenecek Vergiler", "1.201.784"],
    ["Stoklar", "5.000.000", "Ödenmiş Sermaye", "19.070.000"],
    ["Maddi Duran Varlıklar", "5.188.500", "Dönem Zararı", "-3.690.575"],
  ];
  return (
    <div className="cp-doc">
      <div className="cp-doc-head">
        <b>Demo A.Ş.</b>
        <span>31 Aralık 2026</span>
      </div>
      <div className="cp-doc-cols">
        <h4>AKTİF</h4>
        <h4>PASİF</h4>
        {rows.map((r) => (
          <div key={r[0]} className="cp-doc-pair">
            <p>
              <span>{r[0]}</span>
              <b>{r[1]}</b>
            </p>
            <p>
              <span>{r[2]}</span>
              <b>{r[3]}</b>
            </p>
          </div>
        ))}
      </div>
      <div className="cp-doc-foot">
        <span>21.433.316</span>
        <span className="ok">DENK</span>
        <span>21.433.316</span>
      </div>
    </div>
  );
}

function Gate({ on }: { on: boolean }) {
  return (
    <div className={`cp-gate${on ? " in" : ""}`}>
      <span className="cp-gate-badge">Onayınızı bekliyor</span>
      <h4>İzleme kur</h4>
      <div className="cp-field">
        <label>Ad</label>
        <div>Kasa alt sınırı</div>
      </div>
      <div className="cp-field">
        <label>Koşul</label>
        <div>Kullanılabilir bakiye 500.000 ₺ altına düşerse</div>
      </div>
      <div className="cp-gate-acts">
        <span className="ghost">Vazgeç</span>
        <span className="solid">Onayla</span>
      </div>
      <p className="cp-gate-note">Onaylanmadan hiçbir kayıt oluşmaz.</p>
    </div>
  );
}

const TABS = [
  {
    id: "muhasebe",
    tab: "Muhasebe",
    q: "31 Aralık itibarıyla bilançoyu çıkar",
    out: "Belge",
    note:
      "Tek Düzen Hesap Planı gruplarıyla, dönem kârı özkaynağa taşınmış hâlde. Aktif ile pasif tutmuyorsa belgenin üzerinde yazar — denksiz bilanço bankaya gitmez.",
  },
  {
    id: "amortisman",
    tab: "Amortisman",
    q: "Makinelerimizin net defter değeri ne kadar?",
    out: "Tablo",
    note:
      "Kaynak Robotu azalan bakiyeler yöntemiyle, Ford Transit binek otomobil olduğu için kıst amortismanla: nisanda alındı, ilk yıl dokuz ay.",
  },
  {
    id: "bordro",
    tab: "Bordro",
    q: "Brüt 135 bin maaşın yıl içindeki seyri ne?",
    out: "Grafik",
    note:
      "Net maaş yıl içinde düşer çünkü kümülatif matrah büyüdükçe vergi dilimi yükselir. Tek ayın on iki katını almak yanlış cevaptır.",
  },
  {
    id: "izleme",
    tab: "İzleme",
    q: "Kasa 500 binin altına düşerse bana haber ver",
    out: "Onay formu",
    note:
      "Kalıcı bir izleme kurulur ve her açılışta kendiliğinden çalışır. Eşik aşılmadıkça sessiz kalır.",
  },
] as const;

export function Capabilities() {
  const [i, setI] = useState(0);
  const { ref, shown } = useReveal<HTMLDivElement>();
  const t = TABS[i]!;

  return (
    <main className="mk-page">
      <PageHead
        eyebrow="Ne yapar"
        title={
          <>
            Soruyu yazın.
            <br />
            <span className="mk-dim">Gerisi sistemin işi.</span>
          </>
        }
        lede="Her soru kendi biçiminde cevaplanır: belge, tablo, grafik ya da onaylamanız gereken bir form. Aşağıdakiler gerçek çıktılar."
      />

      <div ref={ref} className="cp">
        <div className="cp-tabs" role="tablist">
          {TABS.map((c, n) => (
            <button
              key={c.id}
              role="tab"
              aria-selected={n === i}
              className={n === i ? "on" : ""}
              onClick={() => setI(n)}
            >
              {c.tab}
            </button>
          ))}
        </div>

        <div className="cp-panel" key={t.id}>
          <div className="cp-ask">
            <span className="cp-q">"{t.q}"</span>
            <span className="cp-kind">{t.out}</span>
          </div>

          <div className="cp-out">
            {t.id === "muhasebe" && <Doc />}
            {t.id === "amortisman" && (
              <RichText text={ASSET_TABLE} org="Demo A.Ş." question={t.q} animate={false} />
            )}
            {t.id === "bordro" && <Chart on={shown} />}
            {t.id === "izleme" && <Gate on={shown} />}
          </div>

          <p className="cp-note">{t.note}</p>
        </div>
      </div>

      <Reveal>
        <div className="mk-end">
          <p>Sistem 136 işi biliyor. Hangisini kullanacağını kendisi seçiyor.</p>
          <a className="mk-cta" href="/uygulama">
            Sisteme gir
          </a>
        </div>
      </Reveal>
    </main>
  );
}
