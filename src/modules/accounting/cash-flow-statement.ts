/**
 * Nakit akış tablosu — DOLAYLI YÖNTEM.
 *
 * `project_cash_flow` ile karıştırılmamalı ve ikisi de gerekli:
 *
 *   · Projeksiyon GELECEĞE bakar, vade tarihlerinden türer, bir
 *     tahmindir ve imzalanmaz.
 *   · Bu tablo GEÇMİŞE bakar, yevmiye kayıtlarından türer, bir mali
 *     tablodur ve mali müşavir bunu ister.
 *
 * Bilanço ve gelir tablosu vardı; üçüncü temel tablo eksikti. Kâr
 * eden bir şirketin neden nakdi azaldığını yalnızca bu tablo anlatır.
 *
 * ─────────────────────────────────────────────────────────────────
 *
 * NEDEN DOLAYLI YÖNTEM.
 *
 * Doğrudan yöntem her tahsilat ve ödemeyi ayrı ayrı sınıflandırmayı
 * gerektirir — yani her yevmiye fişine bir "nakit akış türü" etiketi.
 * O etiket geçmiş kayıtlarda yok ve geriye dönük atanamaz. Dolaylı
 * yöntem yalnızca BAKİYE DEĞİŞİMLERİNDEN türer; elimizde zaten var.
 *
 * KONTROL SATIRI ZORUNLU. Tablonun ürettiği net değişim, 100+102
 * hesaplarının gerçek değişimine EŞİT olmalıdır. Tutmuyorsa tablo
 * yanlıştır ve bunu tablonun kendisi söylemelidir — çünkü yanlış bir
 * nakit akış tablosu, doğru görünen bir yalandır.
 */

function kurusla(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Hesap kodu → bakiye (borç bakiyesi pozitif). */
export type Balances = ReadonlyMap<string, number>;

export interface CashFlowLine {
  readonly label: string;
  readonly amount: number;
  /** Ana başlık mı ara toplam mı — biçimlendirme için. */
  readonly kind: "item" | "subtotal" | "total";
}

export interface CashFlowStatement {
  readonly from: string;
  readonly to: string;
  readonly operating: readonly CashFlowLine[];
  readonly investing: readonly CashFlowLine[];
  readonly financing: readonly CashFlowLine[];
  readonly operatingTotal: number;
  readonly investingTotal: number;
  readonly financingTotal: number;
  readonly netChange: number;
  readonly openingCash: number;
  readonly closingCash: number;
  /**
   * KONTROL: hesaplanan kapanış ile defterdeki kapanış farkı.
   * Sıfır değilse tablo eksik bir hesap grubunu kaçırmıştır.
   */
  readonly checkDifference: number;
  readonly balanced: boolean;
}

/** Bir grubun (ilk üç hane) toplam bakiyesi. */
function grup(b: Balances, ...kodlar: readonly string[]): number {
  let t = 0;
  for (const [kod, tutar] of b) {
    if (kodlar.some((k) => kod.startsWith(k))) t += tutar;
  }
  return kurusla(t);
}

/** İki dönem arasındaki değişim. */
function fark(acilis: Balances, kapanis: Balances, ...kodlar: readonly string[]): number {
  return kurusla(grup(kapanis, ...kodlar) - grup(acilis, ...kodlar));
}

/*
 * TDHP grupları. Kodlar burada TEK YERDE duruyor; bir hesap grubu
 * unutulursa kontrol satırı bunu yakalar ve tablo kendini "dengesiz"
 * ilan eder.
 */
const NAKIT = ["100", "101", "102", "108"] as const;
const TICARI_ALACAK = ["120", "121", "126", "127", "128"] as const;
const DIGER_ALACAK = ["131", "132", "135", "136"] as const;
const STOK = ["150", "151", "152", "153", "157", "159"] as const;
const PESIN_GIDER = ["180", "181", "280", "281"] as const;
const TICARI_BORC = ["320", "321", "326", "329"] as const;
const DIGER_BORC = ["331", "335", "336", "360", "361", "368", "369"] as const;
const GELECEK_GELIR = ["380", "381", "480", "481"] as const;
const BIRIKMIS_AMORTISMAN = ["257", "268", "278"] as const;
const DURAN_VARLIK = ["250", "251", "252", "253", "254", "255", "256", "258", "260", "264", "267"] as const;
const MALI_BORC = ["300", "303", "304", "305", "306", "400", "405"] as const;
const OZKAYNAK = ["500", "501", "502", "520", "540", "541", "542", "549"] as const;

/**
 * Nakit akış tablosu üretir.
 *
 * @param netProfit Dönem net kârı (gelir tablosundan). Zarar negatiftir.
 * @param opening Dönem başı bakiyeler (borç bakiyesi pozitif).
 * @param closing Dönem sonu bakiyeler.
 */
export function buildCashFlowStatement(
  from: Date,
  to: Date,
  netProfit: number,
  opening: Balances,
  closing: Balances,
): CashFlowStatement {
  const iso = (d: Date) => d.toISOString().slice(0, 10);

  /*
   * VARLIK ARTIŞI NAKDİ AZALTIR, BORÇ ARTIŞI NAKDİ ARTIRIR.
   *
   * İşaret hatası bu tablonun en sık kusurudur ve fark ettirmez:
   * tablo yine "denk" görünür, yalnızca yanlış tarafa yazar. Bu
   * yüzden değişimler ham hâlleriyle değil, nakde ETKİSİYLE yazılıyor.
   */
  const alacakArtisi = fark(opening, closing, ...TICARI_ALACAK, ...DIGER_ALACAK);
  const stokArtisi = fark(opening, closing, ...STOK);
  const pesinGiderArtisi = fark(opening, closing, ...PESIN_GIDER);
  // Borç hesapları alacak bakiyeli: bakiye eksi işaretli tutulur.
  const borcArtisi = -fark(opening, closing, ...TICARI_BORC, ...DIGER_BORC, ...GELECEK_GELIR);
  // Birikmiş amortisman da alacak bakiyeli; artışı dönemin amortismanıdır.
  const amortisman = -fark(opening, closing, ...BIRIKMIS_AMORTISMAN);

  const isletme: CashFlowLine[] = [
    { label: "Dönem net kârı/zararı", amount: kurusla(netProfit), kind: "item" },
    { label: "Amortisman (nakit çıkışı olmayan gider)", amount: amortisman, kind: "item" },
    { label: "Ticari ve diğer alacaklardaki değişim", amount: kurusla(-alacakArtisi), kind: "item" },
    { label: "Stoklardaki değişim", amount: kurusla(-stokArtisi), kind: "item" },
    { label: "Peşin ödenmiş giderlerdeki değişim", amount: kurusla(-pesinGiderArtisi), kind: "item" },
    { label: "Ticari ve diğer borçlardaki değişim", amount: kurusla(borcArtisi), kind: "item" },
  ];
  const isletmeToplam = kurusla(isletme.reduce((s, l) => s + l.amount, 0));
  isletme.push({ label: "İşletme faaliyetlerinden nakit akışı", amount: isletmeToplam, kind: "subtotal" });

  // Duran varlık artışı = yatırım = nakit çıkışı.
  const duranArtis = fark(opening, closing, ...DURAN_VARLIK);
  const yatirim: CashFlowLine[] = [
    { label: "Duran varlık alımları/satışları", amount: kurusla(-duranArtis), kind: "item" },
  ];
  const yatirimToplam = kurusla(yatirim.reduce((s, l) => s + l.amount, 0));
  yatirim.push({ label: "Yatırım faaliyetlerinden nakit akışı", amount: yatirimToplam, kind: "subtotal" });

  // Mali borç ve özkaynak alacak bakiyeli; artışı nakit girişidir.
  const kredi = -fark(opening, closing, ...MALI_BORC);
  const sermaye = -fark(opening, closing, ...OZKAYNAK);
  const finansman: CashFlowLine[] = [
    { label: "Mali borçlardaki değişim", amount: kredi, kind: "item" },
    { label: "Özkaynaklardaki değişim (sermaye, kâr dağıtımı)", amount: sermaye, kind: "item" },
  ];
  const finansmanToplam = kurusla(finansman.reduce((s, l) => s + l.amount, 0));
  finansman.push({
    label: "Finansman faaliyetlerinden nakit akışı",
    amount: finansmanToplam,
    kind: "subtotal",
  });

  const netDegisim = kurusla(isletmeToplam + yatirimToplam + finansmanToplam);
  const acilisNakit = grup(opening, ...NAKIT);
  const kapanisNakit = grup(closing, ...NAKIT);
  const gercekDegisim = kurusla(kapanisNakit - acilisNakit);
  const kontrolFarki = kurusla(netDegisim - gercekDegisim);

  return {
    from: iso(from),
    to: iso(to),
    operating: isletme,
    investing: yatirim,
    financing: finansman,
    operatingTotal: isletmeToplam,
    investingTotal: yatirimToplam,
    financingTotal: finansmanToplam,
    netChange: netDegisim,
    openingCash: acilisNakit,
    closingCash: kapanisNakit,
    checkDifference: kontrolFarki,
    // Yarım kuruş tolerans: yuvarlamadan gelen fark tabloyu bozmaz.
    balanced: Math.abs(kontrolFarki) <= 0.005,
  };
}
