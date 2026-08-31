import type { Metadata } from "next";
import { DetailHead, DetailNext } from "../../marketing/detail-shared.js";

export const metadata: Metadata = {
  title: "Roller · KAELON",
  description:
    "Rolün göremediği araç modele hiç gönderilmez. Yedi rol, on modül " +
    "ve kimin neyi görüp neyi yazabildiği.",
};

/*
 * RAKAMLAR KATALOGDAN ÖLÇÜLDÜ, TAHMİN EDİLMEDİ.
 *
 * `registry.visibleTo(principal).length` ile her rol için tek tek
 * sayıldı. Elle yazılan bir sayı, her yeni tool'da sessizce
 * eskiyor — bu sayfada tam olarak öyle oldu ve 141'de kalmıştı.
 */
const ROLLER = [
  { ad: "Patron", tool: 159, oran: 100 },
  { ad: "CFO", tool: 95, oran: 60 },
  { ad: "Üretim Müdürü", tool: 82, oran: 52 },
  { ad: "Satın Alma", tool: 53, oran: 33 },
  { ad: "Depo Sorumlusu", tool: 40, oran: 25 },
  { ad: "İK Müdürü", tool: 32, oran: 20 },
  { ad: "Operatör", tool: 15, oran: 9 },
] as const;

/** o = okur, y = okur ve yazar, boş = hiç görmez. */
const MODULLER = [
  "Gelir tablosu",
  "Bilanço · mizan",
  "Nakit · banka",
  "Bordro",
  "Satış · fatura",
  "Satın alma",
  "Stok · depo",
  "Üretim · iş emri",
  "Bakım",
  "Kullanıcı yönetimi",
] as const;

const MATRIS: Record<string, readonly ("" | "o" | "y")[]> = {
  Patron:           ["o", "o", "o", "o", "y", "y", "y", "y", "y", "y"],
  CFO:              ["o", "y", "y", "o", "y", "y", "o", "o", "",  ""],
  "Üretim Müdürü":  ["",  "",  "",  "",  "o", "o", "o", "y", "y", ""],
  "Satın Alma":     ["",  "",  "",  "",  "o", "y", "o", "",  "",  ""],
  "Depo Sorumlusu": ["",  "",  "",  "",  "o", "o", "y", "o", "",  ""],
  "İK Müdürü":      ["",  "",  "",  "o", "",  "",  "",  "",  "",  ""],
  Operatör:         ["",  "",  "",  "",  "",  "",  "",  "o", "o", ""],
};

export default function Page() {
  return (
    <section className="mk-sec">
      <DetailHead
        eyebrow="Roller"
        title={
          <>
            Göremediğiniz veriyi
            <br />
            <span className="dim">yapay zekâ da göremez.</span>
          </>
        }
        lede={
          "Çoğu sistemde yetki bir EKRAN GİZLEME ayarıdır: veri gelir, arayüz " +
          "saklar. Burada rolün yetkisi olmayan araç modele hiç gönderilmez — " +
          "uydurabileceği bir şey kalmaz."
        }
      />

      {/* ── Araç sayısı ── */}
      <article className="dt-block k-rise">
        <header>
          <span className="mk-kind">ÖLÇÜLDÜ</span>
          <h2>Yedi rol, 159 iş</h2>
          <p>
            Aşağıdaki sayılar tahmin değil: her rol için katalog gerçekten
            filtrelenip sayıldı. Operatör 15 araç görür, patron 159.
          </p>
        </header>

        <div className="rl-list">
          {ROLLER.map((r) => (
            <div key={r.ad}>
              <span className="rl-name">{r.ad}</span>
              <span className="rl-bar">
                <i style={{ width: `${r.oran}%` }} />
              </span>
              <span className="rl-num">{r.tool}</span>
            </div>
          ))}
        </div>
        <p className="mk-mono">CATALOGFOR(PRINCIPAL) · ÜRETİM ÖLÇÜMÜ</p>
      </article>

      {/* ── Matris ── */}
      <article className="dt-block k-rise">
        <header>
          <span className="mk-kind">MATRİS</span>
          <h2>Kim neyi görür</h2>
          <p>
            Boş hücre &ldquo;gizlendi&rdquo; demek değil,{" "}
            <strong>&ldquo;o araç modele gönderilmedi&rdquo;</strong> demek. Depo
            sorumlusuna maaş sorulduğunda cevap &ldquo;yetkiniz yok&rdquo; olur —
            çünkü bakacak bir yer yoktur.
          </p>
        </header>

        <div className="scroll-x">
          <table className="rl-matrix">
            <thead>
              <tr>
                <th />
                {MODULLER.map((m) => (
                  <th key={m}>
                    <span>{m}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ROLLER.map((r) => (
                <tr key={r.ad}>
                  <th scope="row">{r.ad}</th>
                  {MATRIS[r.ad]!.map((v, i) => (
                    <td key={MODULLER[i]} className={v || "none"}>
                      {v === "y" ? "Y" : v === "o" ? "O" : ""}
                      <em>
                        {v === "y"
                          ? `${r.ad}: ${MODULLER[i]} — okur ve yazar`
                          : v === "o"
                            ? `${r.ad}: ${MODULLER[i]} — okur`
                            : `${r.ad}: ${MODULLER[i]} — erişimi yok`}
                      </em>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="rl-legend">
          <span>
            <b className="o">O</b> okur
          </span>
          <span>
            <b className="y">Y</b> okur ve yazar (onay kapılı)
          </span>
          <span>
            <b className="none">·</b> araç modele gönderilmez
          </span>
        </div>
      </article>

      {/* ── İki katman ── */}
      <article className="dt-block k-rise">
        <header>
          <span className="mk-kind">NASIL ÇALIŞIR</span>
          <h2>İki katman, biri diğerine güvenmez</h2>
          <p>
            Yetki tek yerde kontrol edilseydi, o yerin atlanması her şeyi
            açardı. Burada iki bağımsız kapı var.
          </p>
        </header>

        <div className="dt-src">
          <div>
            <b>1 · KATALOG FİLTRESİ</b>
            <span>
              Model yalnızca rolün yetkili olduğu araçların tarifini görür.
              Diğerlerinin var olduğunu bilmez.
            </span>
          </div>
          <div>
            <b>2 · ÇAĞRI DENETİMİ</b>
            <span>
              Araç çalıştırılmadan önce yetki YENİDEN kontrol edilir. Filtre
              atlansa bile çağrı reddedilir.
            </span>
          </div>
          <div>
            <b>GÖREVLER AYRILIĞI</b>
            <span>
              Kendi talebinizi onaylayamazsınız. Talebi açan ve onaylayan aynı
              kişi olamaz.
            </span>
          </div>
          <div>
            <b>YETKİ SEVİYESİ 0–3</b>
            <span>
              Okuma serbest; yazma onay ister; geri alınamayan işlem ayrıca
              yetki ister.
            </span>
          </div>
        </div>
      </article>

      <DetailNext current="/roller" />
    </section>
  );
}
