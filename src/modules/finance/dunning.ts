/**
 * Borç ihtarı — vadesi geçmiş alacağa kademeli hatırlatma.
 *
 * TAHSİL EDİLMEYEN SATIŞ, YAPILMAMIŞ SATIŞTAN KÖTÜDÜR: malı gitmiş,
 * parası gelmemiş, üstüne KDV'si beyan edilmiştir. Sistemde alacak
 * yaşlandırma vardı ama yaşlandırmayı GÖREN bir insan gerekiyordu.
 * İhtar, o bakışı süreç hâline getirir.
 *
 * ─────────────────────────────────────────────────────────────────
 *
 * KADEME İŞLETMENİN KARARIDIR, KODUN DEĞİL. Bir makina imalatçısı 30
 * günde nazik bir hatırlatma yazar; bir nakliyeci 7 günde keser. Gün
 * eşikleri ve metin veritabanında durur.
 *
 * BİR CARİYE BİR İHTAR, FATURA BAŞINA DEĞİL. Aynı müşteriye üç ayrı
 * mektup göndermek hem saçmadır hem de ilişkiyi bozar. Kademe, o
 * carinin EN ESKİ gecikmesine göre belirlenir — en ağır durumu neyse
 * ihtar odur.
 *
 * ZATEN GÖNDERİLMİŞ KADEME TEKRARLANMAZ. İkinci ihtarı iki kez
 * göndermek, ihtarın hukuki değerini de ciddiyetini de düşürür.
 */

function kurusla(n: number): number {
  return Math.round(n * 100) / 100;
}

const GUN = 86_400_000;

export class DunningError extends Error {
  readonly code = "dunning";
  constructor(message: string) {
    super(message);
    this.name = "DunningError";
  }
}

export interface DunningLevel {
  readonly level: number;
  readonly minOverdueDays: number;
  readonly label: string;
  /** Yıllık gecikme faizi; null = faiz işletilmiyor. */
  readonly interestRate: number | null;
}

export interface OverdueInvoice {
  readonly documentNo: string;
  readonly partnerId: string;
  readonly partnerName: string;
  readonly openAmount: number;
  readonly currency: string;
  readonly dueDate: Date;
}

export interface DunningCandidate {
  readonly partnerId: string;
  readonly partnerName: string;
  readonly level: number;
  readonly levelLabel: string;
  readonly totalAmount: number;
  readonly currency: string;
  readonly oldestOverdueDays: number;
  readonly invoiceNos: readonly string[];
  /** Gecikme faizi — kademede oran tanımlıysa. */
  readonly interest: number;
  /** Bu cariye daha önce gönderilen en yüksek kademe. */
  readonly previousLevel: number | null;
}

export interface DunningPlan {
  readonly asOf: string;
  readonly candidates: readonly DunningCandidate[];
  readonly totalAmount: number;
  /**
   * Vadesi geçmiş ama HİÇBİR kademeye girmeyenler — henüz erken.
   * Sayısı gösterilir ki kullanıcı "neden bu fatura yok" diye sormasın.
   */
  readonly tooEarly: { readonly count: number; readonly amount: number };
}

/**
 * Kademeleri sıraya koyar ve doğrular.
 *
 * ARTAN OLMAK ZORUNDA: 2. kademe 1.'den daha uzun gecikmede
 * tetiklenmeli. Aksi hâlde bir fatura aynı anda iki kademeye girer ve
 * hangisinin geçerli olduğu belirsizleşir.
 */
export function sortLevels(levels: readonly DunningLevel[]): readonly DunningLevel[] {
  const s = [...levels].sort((a, b) => a.level - b.level);
  for (let i = 1; i < s.length; i++) {
    if (s[i]!.minOverdueDays <= s[i - 1]!.minOverdueDays) {
      throw new DunningError(
        `${s[i]!.level}. kademe ${s[i]!.minOverdueDays} günde tetikleniyor ama ` +
          `${s[i - 1]!.level}. kademe ${s[i - 1]!.minOverdueDays} günde. Kademeler ` +
          `ARTAN olmalı; aksi hâlde bir fatura iki kademeye birden girer.`,
      );
    }
  }
  return s;
}

/** Gecikmeye uyan en yüksek kademe; hiçbiri uymuyorsa null. */
function kademeFor(days: number, levels: readonly DunningLevel[]): DunningLevel | null {
  let bulunan: DunningLevel | null = null;
  for (const l of levels) {
    if (days >= l.minOverdueDays) bulunan = l;
  }
  return bulunan;
}

/**
 * Gecikme faizi — basit faiz, gün bazlı.
 *
 * BİLEŞİK DEĞİL, KASITLI. Ticari alacakta gecikme faizi Türkiye'de
 * basit hesaplanır ve bileşik hesaplamak, ihtarın hukuki dayanağını
 * tartışmalı hâle getirir. Fazla istenen faiz, alacağın tamamını
 * tehlikeye atar.
 */
export function lateInterest(amount: number, days: number, annualRate: number | null): number {
  if (annualRate === null || annualRate <= 0 || days <= 0) return 0;
  return kurusla((amount * (annualRate / 100) * days) / 365);
}

/**
 * İhtar planı — hangi cariye hangi kademe.
 *
 * @param previousLevels Cari kimliği → daha önce gönderilen en yüksek kademe.
 */
export function planDunning(
  asOf: Date,
  overdue: readonly OverdueInvoice[],
  levels: readonly DunningLevel[],
  previousLevels: ReadonlyMap<string, number> = new Map(),
): DunningPlan {
  const sirali = sortLevels(levels);
  if (sirali.length === 0) {
    throw new DunningError(
      "Hiç ihtar kademesi tanımlı değil. Kaç günde ne yazılacağı işletmenin " +
        "kararıdır ve önce tanımlanmalıdır.",
    );
  }

  const bugun = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate()));
  const gecikme = (d: Date) => Math.floor((bugun.getTime() - d.getTime()) / GUN);

  // Cari bazında topla: bir cariye bir mektup.
  const cariler = new Map<string, OverdueInvoice[]>();
  for (const inv of overdue) {
    if (inv.openAmount <= 0) continue;
    if (gecikme(inv.dueDate) <= 0) continue;
    const liste = cariler.get(inv.partnerId) ?? [];
    liste.push(inv);
    cariler.set(inv.partnerId, liste);
  }

  const adaylar: DunningCandidate[] = [];
  let erkenAdet = 0;
  let erkenTutar = 0;

  for (const [partnerId, faturalar] of cariler) {
    const enEski = Math.max(...faturalar.map((f) => gecikme(f.dueDate)));
    const kademe = kademeFor(enEski, sirali);
    const toplam = kurusla(faturalar.reduce((s, f) => s + f.openAmount, 0));

    if (!kademe) {
      erkenAdet += faturalar.length;
      erkenTutar = kurusla(erkenTutar + toplam);
      continue;
    }

    /*
     * ZATEN GÖNDERİLMİŞ KADEME TEKRARLANMAZ.
     *
     * Cari 2. kademeyi aldıysa ve hâlâ 2. kademedeyse yeni mektup
     * çıkmaz. Ancak 3. kademeye GEÇTİYSE çıkar — durum ağırlaşmıştır
     * ve bunu bildirmek ihtarın kendisidir.
     */
    const onceki = previousLevels.get(partnerId) ?? null;
    if (onceki !== null && kademe.level <= onceki) continue;

    const faiz = faturalar.reduce(
      (s, f) => s + lateInterest(f.openAmount, gecikme(f.dueDate), kademe.interestRate),
      0,
    );

    adaylar.push({
      partnerId,
      partnerName: faturalar[0]!.partnerName,
      level: kademe.level,
      levelLabel: kademe.label,
      totalAmount: toplam,
      currency: faturalar[0]!.currency,
      oldestOverdueDays: enEski,
      // En eski önce: mektupta da o sırayla okunmalı.
      invoiceNos: [...faturalar]
        .sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime())
        .map((f) => f.documentNo),
      interest: kurusla(faiz),
      previousLevel: onceki,
    });
  }

  // En ağır durum önce: kademe, sonra gecikme.
  adaylar.sort((a, b) => b.level - a.level || b.oldestOverdueDays - a.oldestOverdueDays);

  return {
    asOf: bugun.toISOString().slice(0, 10),
    candidates: adaylar,
    totalAmount: kurusla(adaylar.reduce((s, c) => s + c.totalAmount, 0)),
    tooEarly: { count: erkenAdet, amount: erkenTutar },
  };
}
