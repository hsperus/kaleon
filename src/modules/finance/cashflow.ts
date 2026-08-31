/**
 * Nakit akış projeksiyonu.
 *
 * PATRONUN GÜNLÜK SORUSU BUYDU VE SİSTEMDE CEVABI YOKTU: "önümüzdeki
 * ay nakit sıkışır mıyız?" Bilanço dünü anlatır, mizan fişleri
 * denetler; ikisi de gelecek hafta banka hesabında ne olacağını
 * söylemez. Bir imalatçı batmadan önce kârlıdır — nakdi biter.
 *
 * ─────────────────────────────────────────────────────────────────
 *
 * GECİKMİŞ ALACAK İLE GECİKMİŞ BORÇ AYNI ŞEY DEĞİLDİR.
 *
 * Vadesi geçmiş bir BORÇ bugün bize aittir: alacaklı her an
 * isteyebilir, projeksiyona bugünün çıkışı olarak girer.
 *
 * Vadesi geçmiş bir ALACAK ise gelmemiş paradır. Onu "bu hafta
 * tahsil edilecek" saymak, projeksiyonu tam da en çok güvenilmesi
 * gereken yerde iyimser yapar — nakit sıkıntısı zaten geciken
 * tahsilattan doğar. Gecikmiş alacak projeksiyona GİRMEZ; ayrı
 * satırda, tutarıyla ve gün sayısıyla gösterilir.
 *
 * Bu asimetri bilerek konmuştur. İki tarafı da aynı saymak
 * matematiksel olarak daha zarif olurdu ve işletmeyi yanıltırdı.
 *
 * VADESİ BİLİNMEYEN BELGE PROJEKSİYONA GİRMEZ. Bir tarih uydurup
 * haftalardan birine koymak, o haftanın rakamını sessizce bozar.
 * Ayrı başlıkta toplanır ki kullanıcı vadeyi girmeye gitsin.
 */

/** Yuvarlama: kuruş. Küsurat haftalar boyunca birikirse toplam kayar. */
function kurusla(n: number): number {
  return Math.round(n * 100) / 100;
}

const GUN = 86_400_000;

export interface CashItem {
  /** Belge numarası — kullanıcı bunu sistemde arayacak. */
  readonly documentNo: string;
  readonly partnerName: string;
  /** Kalan açık tutar (TL). */
  readonly amount: number;
  /** null: vade bilinmiyor. Uydurulmaz. */
  readonly dueDate: Date | null;
}

export interface CashWeek {
  readonly weekNo: number;
  readonly from: string;
  readonly to: string;
  readonly inflow: number;
  readonly outflow: number;
  readonly net: number;
  /** Hafta sonundaki tahmini nakit. */
  readonly closing: number;
}

export interface CashFlowProjection {
  readonly asOf: string;
  readonly openingCash: number;
  readonly weeks: readonly CashWeek[];
  /** Nakdin ilk kez eksiye düştüğü hafta; yoksa null. */
  readonly shortfallWeek: number | null;
  /** O haftadaki açık (pozitif sayı olarak). */
  readonly shortfallAmount: number;
  /** Projeksiyona GİRMEYEN gecikmiş alacaklar. */
  readonly overdueReceivables: { readonly count: number; readonly amount: number };
  /** Vadesi geçmiş borçlar — bugünün çıkışı olarak İLK HAFTAYA girer. */
  readonly overduePayables: { readonly count: number; readonly amount: number };
  /** Vadesi bilinmediği için hiçbir haftaya konamayan belgeler. */
  readonly undated: {
    readonly receivableCount: number;
    readonly receivableAmount: number;
    readonly payableCount: number;
    readonly payableAmount: number;
  };
}

/** Haftanın başlangıcı — pazartesi. Türkiye'de iş haftası oradan sayılır. */
function haftaBasi(d: Date): Date {
  const g = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  // getUTCDay: pazar 0. Pazartesiye çekmek için pazarı 7 sayıyoruz.
  const gun = g.getUTCDay() === 0 ? 7 : g.getUTCDay();
  return new Date(g.getTime() - (gun - 1) * GUN);
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Haftalık nakit projeksiyonu.
 *
 * @param openingCash Bugünkü banka + kasa toplamı.
 * @param weeks Kaç hafta ileri bakılacak.
 */
export function projectCashFlow(
  asOf: Date,
  openingCash: number,
  receivables: readonly CashItem[],
  payables: readonly CashItem[],
  weeks: number,
): CashFlowProjection {
  const bugun = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate()));
  const ilkHafta = haftaBasi(bugun);

  const vadesiz = (xs: readonly CashItem[]) => xs.filter((x) => x.dueDate === null);
  const gecikmis = (xs: readonly CashItem[]) =>
    xs.filter((x) => x.dueDate !== null && x.dueDate.getTime() < bugun.getTime());
  const topla = (xs: readonly CashItem[]) => kurusla(xs.reduce((s, x) => s + x.amount, 0));

  const vadesizAlacak = vadesiz(receivables);
  const vadesizBorc = vadesiz(payables);
  const gecikmisAlacak = gecikmis(receivables);
  const gecikmisBorc = gecikmis(payables);

  /** Bir belgenin hangi haftaya düştüğü; ufkun dışındaysa -1. */
  const haftaIndeksi = (due: Date): number => {
    const fark = Math.floor((haftaBasi(due).getTime() - ilkHafta.getTime()) / (7 * GUN));
    return fark >= 0 && fark < weeks ? fark : -1;
  };

  const girisler = new Array<number>(weeks).fill(0);
  const cikislar = new Array<number>(weeks).fill(0);

  // Gecikmiş borç bugünün yüküdür — ilk haftaya.
  cikislar[0] = topla(gecikmisBorc);

  for (const r of receivables) {
    if (r.dueDate === null || r.dueDate.getTime() < bugun.getTime()) continue;
    const i = haftaIndeksi(r.dueDate);
    if (i >= 0) girisler[i] = kurusla(girisler[i]! + r.amount);
  }
  for (const p of payables) {
    if (p.dueDate === null || p.dueDate.getTime() < bugun.getTime()) continue;
    const i = haftaIndeksi(p.dueDate);
    if (i >= 0) cikislar[i] = kurusla(cikislar[i]! + p.amount);
  }

  const satirlar: CashWeek[] = [];
  let bakiye = kurusla(openingCash);
  let acikHafta: number | null = null;
  let acikTutar = 0;

  for (let i = 0; i < weeks; i++) {
    const bas = new Date(ilkHafta.getTime() + i * 7 * GUN);
    const son = new Date(bas.getTime() + 6 * GUN);
    const net = kurusla(girisler[i]! - cikislar[i]!);
    bakiye = kurusla(bakiye + net);

    if (bakiye < 0 && acikHafta === null) {
      acikHafta = i + 1;
      acikTutar = kurusla(-bakiye);
    }

    satirlar.push({
      weekNo: i + 1,
      from: iso(bas),
      to: iso(son),
      inflow: girisler[i]!,
      outflow: cikislar[i]!,
      net,
      closing: bakiye,
    });
  }

  return {
    asOf: iso(bugun),
    openingCash: kurusla(openingCash),
    weeks: satirlar,
    shortfallWeek: acikHafta,
    shortfallAmount: acikTutar,
    overdueReceivables: { count: gecikmisAlacak.length, amount: topla(gecikmisAlacak) },
    overduePayables: { count: gecikmisBorc.length, amount: topla(gecikmisBorc) },
    undated: {
      receivableCount: vadesizAlacak.length,
      receivableAmount: topla(vadesizAlacak),
      payableCount: vadesizBorc.length,
      payableAmount: topla(vadesizBorc),
    },
  };
}
