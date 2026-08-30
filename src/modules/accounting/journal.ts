/**
 * Yevmiye fişi — muhasebenin tek yazma birimi.
 *
 * ÇİFT TARAFLI KAYIT BİR TERCİH DEĞİL, BİR KONTROLDÜR. Her fişte borç
 * toplamı alacak toplamına eşit olmak zorundadır; eşit değilse mizan
 * tutmaz ve tutmayan mizan hiçbir soruya cevap veremez. Bu kural burada,
 * veritabanında ve testte ayrı ayrı korunuyor — çünkü bir kez bozulursa
 * hangi fişten bozulduğunu bulmak günler alır.
 *
 * FİŞ BELGEDEN DOĞAR, ELLE YAZILMAZ. Fatura kesilir → fiş oluşur; ödeme
 * kaydedilir → fiş oluşur. Elle fiş girişi de mümkündür (açılış kaydı,
 * amortisman, düzeltme) ama İSTİSNADIR. Kayıtların çoğunun elle girildiği
 * bir sistemde muhasebe, operasyondan kopar ve iki ayrı gerçek doğar.
 *
 * KESİLEN FİŞ DEĞİŞTİRİLEMEZ. Yanlışsa TERS KAYIT atılır. Değiştirilebilseydi,
 * geçmiş bir dönemin mizanı bugün başka çıkardı ve verilmiş beyanname
 * dayanaksız kalırdı.
 */

import { account, accountExists, signedBalance, type Account } from "./accounts.js";

export const JOURNAL_STATUSES = ["draft", "posted", "reversed"] as const;
export type JournalStatus = (typeof JOURNAL_STATUSES)[number];

/** Fişi doğuran belge türü — izlenebilirliğin halkası. */
export const JOURNAL_SOURCES = [
  "sales_invoice",
  "purchase_invoice",
  "delivery",
  "goods_receipt",
  "payment",
  "stock_movement",
  "manual",
  "period_close",
] as const;
export type JournalSource = (typeof JOURNAL_SOURCES)[number];

export class JournalError extends Error {
  readonly code = "journal";
  constructor(message: string) {
    super(message);
    this.name = "JournalError";
  }
}

export interface DraftLine {
  readonly accountCode: string;
  readonly debit: number;
  readonly credit: number;
  readonly description: string;
  /** Cari kırılımı — 120/320 gibi hesaplarda zorunlu. */
  readonly partnerId?: string | null;
}

export interface BalancedEntry {
  readonly lines: readonly (DraftLine & { lineNo: number })[];
  readonly totalDebit: number;
  readonly totalCredit: number;
}

/** Kuruş toplamı — tam sayıda toplanır, kayan noktada değil. */
function kurus(n: number): number {
  return Math.round(n * 100);
}

/**
 * Fişi doğrular ve dengeler.
 *
 * ÜÇ KURAL, ÜÇ AYRI HATA:
 *   1. Bir satır ya borç ya alacak olur; ikisi birden dolu olamaz.
 *      Dolabilseydi "net 300 borç" gibi satırlar doğar ve fişin okunması
 *      hesap makinesi gerektirirdi.
 *   2. Toplamlar eşit olmalıdır — çift taraflı kaydın kendisi budur.
 *   3. Cari hesaplarda cari kimliği zorunludur. Olmasaydı "Alıcılar
 *      1.250.000 TL" satırı, kimden alacaklı olduğumuzu söylemezdi.
 */
export function balance(lines: readonly DraftLine[]): BalancedEntry {
  if (lines.length < 2) {
    throw new JournalError(
      "Yevmiye fişi en az iki satır içermelidir; tek satırlı bir kayıt çift taraflı olamaz.",
    );
  }

  let debit = 0;
  let credit = 0;
  const out: (DraftLine & { lineNo: number })[] = [];

  lines.forEach((l, i) => {
    const a: Account = account(l.accountCode);

    if (l.debit < 0 || l.credit < 0) {
      throw new JournalError(
        `${l.accountCode} satırında negatif tutar var. Ters kayıt, negatif tutarla değil ` +
          `karşı tarafa yazarak yapılır.`,
      );
    }
    if (l.debit > 0 && l.credit > 0) {
      throw new JournalError(
        `${l.accountCode} satırı hem borç hem alacak taşıyor. Bir satır tek yönlüdür.`,
      );
    }
    if (l.debit === 0 && l.credit === 0) {
      throw new JournalError(`${l.accountCode} satırının tutarı sıfır; boş satır yazılmaz.`);
    }
    if (a.subledger === "partner" && !l.partnerId) {
      throw new JournalError(
        `${a.code} ${a.name} hesabı cari kırılımı ister; hangi cariye ait olduğu ` +
          `yazılmadan kayıt atılamaz.`,
      );
    }

    debit += kurus(l.debit);
    credit += kurus(l.credit);
    out.push({ ...l, lineNo: i + 1 });
  });

  if (debit !== credit) {
    throw new JournalError(
      `Fiş DENK DEĞİL: borç ${(debit / 100).toFixed(2)}, alacak ${(credit / 100).toFixed(2)}, ` +
        `fark ${((debit - credit) / 100).toFixed(2)}. Denk olmayan fiş kaydedilemez.`,
    );
  }

  return { lines: out, totalDebit: debit / 100, totalCredit: credit / 100 };
}

/**
 * Ters kayıt satırları — borç ve alacak yer değiştirir.
 *
 * Tutarlar NEGATİFLENMEZ, tarafları değişir. Negatiflenseydi mizanda
 * "eksi borç" diye bir şey doğar ve toplamlar okunamaz hâle gelirdi.
 */
export function reverseLines(lines: readonly DraftLine[]): readonly DraftLine[] {
  return lines.map((l) => ({
    ...l,
    debit: l.credit,
    credit: l.debit,
    description: `İPTAL — ${l.description}`,
  }));
}

export interface TrialBalanceRow {
  readonly accountCode: string;
  readonly accountName: string;
  readonly debit: number;
  readonly credit: number;
  /** Hesabın normal yönüne göre işaretli bakiye. */
  readonly balance: number;
  readonly statement: "bilanco" | "gelir";
}

/**
 * Mizan satırlarını kurar ve DENKLİĞİ KONTROL EDER.
 *
 * Mizanın toplamları eşit değilse bir yerde tek taraflı kayıt vardır ve
 * bu, tüm mali tabloları geçersiz kılar. Rapor "denk değil" demeden
 * gösterilmemelidir; sessizce gösterilen bozuk bir mizan, hiç
 * gösterilmemesinden kötüdür çünkü ona güvenilir.
 */
export function trialBalance(
  totals: readonly { accountCode: string; debit: number; credit: number }[],
): { rows: readonly TrialBalanceRow[]; totalDebit: number; totalCredit: number; balanced: boolean } {
  let td = 0;
  let tc = 0;
  const rows = totals
    .map((t) => {
      const a = account(t.accountCode);
      td += kurus(t.debit);
      tc += kurus(t.credit);
      return {
        accountCode: a.code,
        accountName: a.name,
        debit: t.debit,
        credit: t.credit,
        balance: signedBalance(a, t.debit, t.credit),
        statement: a.statement,
      };
    })
    .sort((a, b) => a.accountCode.localeCompare(b.accountCode));

  return {
    rows,
    totalDebit: td / 100,
    totalCredit: tc / 100,
    balanced: td === tc,
  };
}

/** Gelir tablosu özeti — 6xx ve 7xx hesaplardan. */
export function incomeSummary(rows: readonly TrialBalanceRow[]): {
  revenue: number;
  cogs: number;
  expenses: number;
  grossProfit: number;
  netProfit: number;
} {
  let revenue = 0;
  let cogs = 0;
  let expenses = 0;

  for (const r of rows) {
    if (r.statement !== "gelir") continue;
    const cls = r.accountCode.slice(0, 3);
    if (cls === "600" || cls === "601") revenue += r.balance;
    else if (cls === "610" || cls === "611") revenue -= r.balance;
    else if (cls === "620" || cls === "621") cogs += r.balance;
    else if (cls === "646") revenue += r.balance;
    else expenses += r.balance;
  }

  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    revenue: round(revenue),
    cogs: round(cogs),
    expenses: round(expenses),
    grossProfit: round(revenue - cogs),
    netProfit: round(revenue - cogs - expenses),
  };
}

/* ═══════════════════════════════════════════════════════════════════
 * BİLANÇO
 *
 * GELİR TABLOSU VARDI, BİLANÇO YOKTU. İkisi birlikte "mali tablo"dur:
 * gelir tablosu dönemde ne kazanıldığını, bilanço o an neye sahip
 * olunduğunu söyler. Bankaya, mali müşavire ve ortağa verilen tablo
 * bilançodur; onsuz bir ERP mali tablo üretmiyor demektir.
 *
 * DÖNEM KÂRI ÖZKAYNAĞA TAŞINIR — YOKSA BİLANÇO DENK GELMEZ. Gelir
 * tablosu hesapları (6xx/7xx) bilançoda yer almaz; dönem içinde
 * kazanılan kâr henüz 590'a aktarılmamış olabilir. Aktarılmadan
 * bilanço kurulursa aktif ile pasif arasında tam olarak dönem kârı
 * kadar fark kalır ve tablo "bozuk" görünür. Bu, bilanço yazan
 * herkesin bir kez düştüğü tuzaktır.
 * ═══════════════════════════════════════════════════════════════════ */

export interface BalanceGroup {
  readonly code: string;
  readonly label: string;
  readonly amount: number;
  readonly lines: readonly { code: string; name: string; amount: number }[];
}

export interface BalanceSheet {
  readonly assets: readonly BalanceGroup[];
  readonly liabilities: readonly BalanceGroup[];
  readonly totalAssets: number;
  readonly totalLiabilities: number;
  /** Dönem net kârı — özkaynak içinde ayrı gösterilir. */
  readonly periodResult: number;
  /** Aktif = Pasif mi. Değilse tablo YAYIMLANMAMALI. */
  readonly balanced: boolean;
  /** Denk değilse fark; denkse 0. */
  readonly difference: number;
}

/**
 * TDHP bilanço grupları.
 *
 * Resmî bilanço formatındaki başlıklar. Hesapları sınıf koduna göre
 * (ilk hane) değil GRUP koduna göre (ilk iki hane) toplamak şart:
 * 120 "Ticari Alacaklar", 159 "Diğer Dönen Varlıklar" — ikisi de 1xx
 * ama bilançoda ayrı satırlardır.
 */
const ASSET_GROUPS: readonly { prefixes: readonly string[]; code: string; label: string }[] = [
  { code: "A", label: "Hazır Değerler", prefixes: ["10"] },
  { code: "B", label: "Menkul Kıymetler", prefixes: ["11"] },
  { code: "C", label: "Ticari Alacaklar", prefixes: ["12"] },
  { code: "D", label: "Diğer Alacaklar", prefixes: ["13"] },
  { code: "E", label: "Stoklar", prefixes: ["15"] },
  { code: "F", label: "Yıllara Yaygın İnşaat ve Onarım Maliyetleri", prefixes: ["17"] },
  { code: "G", label: "Gelecek Aylara Ait Giderler ve Gelir Tahakkukları", prefixes: ["18"] },
  { code: "H", label: "Diğer Dönen Varlıklar", prefixes: ["19"] },
  { code: "I", label: "Duran Varlıklar — Ticari Alacaklar", prefixes: ["22"] },
  { code: "J", label: "Mali Duran Varlıklar", prefixes: ["24"] },
  { code: "K", label: "Maddi Duran Varlıklar", prefixes: ["25"] },
  { code: "L", label: "Maddi Olmayan Duran Varlıklar", prefixes: ["26"] },
  { code: "M", label: "Gelecek Yıllara Ait Giderler", prefixes: ["28"] },
];

const LIABILITY_GROUPS: readonly { prefixes: readonly string[]; code: string; label: string }[] = [
  { code: "A", label: "Mali Borçlar", prefixes: ["30"] },
  { code: "B", label: "Ticari Borçlar", prefixes: ["32"] },
  { code: "C", label: "Diğer Borçlar", prefixes: ["33"] },
  { code: "D", label: "Alınan Avanslar", prefixes: ["34"] },
  { code: "E", label: "Ödenecek Vergi ve Diğer Yükümlülükler", prefixes: ["36"] },
  { code: "F", label: "Borç ve Gider Karşılıkları", prefixes: ["37"] },
  { code: "G", label: "Gelecek Aylara Ait Gelirler", prefixes: ["38"] },
  { code: "H", label: "Diğer Kısa Vadeli Yabancı Kaynaklar", prefixes: ["39"] },
  { code: "I", label: "Uzun Vadeli Mali Borçlar", prefixes: ["40"] },
  { code: "J", label: "Uzun Vadeli Ticari Borçlar", prefixes: ["42"] },
  { code: "K", label: "Uzun Vadeli Diğer Borçlar", prefixes: ["43", "47"] },
  { code: "L", label: "Ödenmiş Sermaye", prefixes: ["50"] },
  { code: "M", label: "Sermaye Yedekleri", prefixes: ["52"] },
  { code: "N", label: "Kâr Yedekleri", prefixes: ["54"] },
  { code: "O", label: "Geçmiş Yıllar Kârları / Zararları", prefixes: ["57", "58"] },
];

/**
 * Bilanço tarafına göre işaret düzeltmesi.
 *
 * KONTRA HESAP, DURDUĞU TARAFI AZALTIR. 257 Birikmiş Amortismanlar
 * aktifte yer alır ama ALACAK bakiyelidir; `signedBalance` onu artı
 * verir çünkü hesabın kendi doğasına göre doğrudur. Bilançoda ise
 * duran varlıklardan DÜŞÜLMESİ gerekir.
 *
 * CANLI VERİDE YAKALANDI: demo bilançosu tam olarak birikmiş
 * amortismanın İKİ KATI kadar (2.200.000) fark verdi — bir kez
 * eksiltilmediği, bir kez de eklendiği için. Aynı kural pasif tarafı
 * için de geçerlidir: 591 Dönem Net Zararı borç bakiyelidir ve
 * özkaynağı azaltır.
 *
 * Bu hatayı ilk testler yakalayamamıştı çünkü yalnızca satır SAYISINI
 * kontrol ediyorlardı, TUTARI değil.
 */
function sideAmount(row: TrialBalanceRow, side: "aktif" | "pasif"): number {
  // Tanınmayan hesap için işaret değiştirilmez: uydurma bir yön,
  // bilinmeyen bir hesabı yanlış tarafa yazmaktan kötüdür.
  if (!accountExists(row.accountCode)) return row.balance;
  const a = account(row.accountCode);
  const belongsToSide = side === "aktif" ? a.normal === "borc" : a.normal === "alacak";
  return belongsToSide ? row.balance : -row.balance;
}

function collect(
  rows: readonly TrialBalanceRow[],
  groups: readonly { prefixes: readonly string[]; code: string; label: string }[],
  used: Set<string>,
  side: "aktif" | "pasif",
): BalanceGroup[] {
  const out: BalanceGroup[] = [];
  for (const g of groups) {
    const lines = rows
      .filter((r) => g.prefixes.some((p) => r.accountCode.startsWith(p)))
      .map((r) => {
        used.add(r.accountCode);
        return { code: r.accountCode, name: r.accountName, amount: sideAmount(r, side) };
      });
    if (lines.length === 0) continue;
    const amount = lines.reduce((s, l) => s + l.amount, 0);
    out.push({ code: g.code, label: g.label, amount: round2(amount), lines });
  }
  return out;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Bilanço kurar.
 *
 * @param rows Mizan satırları (bilanço hesapları süzülür).
 * @param periodResult Dönem net kârı/zararı — gelir tablosundan gelir.
 */
export function balanceSheet(
  rows: readonly TrialBalanceRow[],
  periodResult: number,
): BalanceSheet {
  const sheet = rows.filter((r) => r.statement === "bilanco");
  const used = new Set<string>();

  const assets = collect(sheet, ASSET_GROUPS, used, "aktif");
  const liabilities = collect(sheet, LIABILITY_GROUPS, used, "pasif");

  /*
   * HİÇBİR HESAP SESSİZCE DÜŞMEZ.
   *
   * Bir hesap hiçbir gruba girmiyorsa bilanço eksik kalır ve fark
   * "denk değil" olarak görünür — ama nedenini kimse bilemez. Grupsuz
   * hesaplar bakiye yönüne göre uygun tarafta "Diğer" başlığında
   * toplanır ve kod listesi görünür kalır.
   */
  const orphans = sheet.filter((r) => !used.has(r.accountCode) && r.balance !== 0);
  const assetOrphans = orphans.filter((r) => r.balance > 0 && Number(r.accountCode[0]) <= 2);
  const liabOrphans = orphans.filter((r) => !(r.balance > 0 && Number(r.accountCode[0]) <= 2));

  if (assetOrphans.length > 0) {
    assets.push({
      code: "Z",
      label: "Sınıflandırılmamış aktif hesaplar",
      amount: round2(assetOrphans.reduce((s, r) => s + sideAmount(r, "aktif"), 0)),
      lines: assetOrphans.map((r) => ({
        code: r.accountCode,
        name: r.accountName,
        amount: sideAmount(r, "aktif"),
      })),
    });
  }
  if (liabOrphans.length > 0) {
    liabilities.push({
      code: "Z",
      label: "Sınıflandırılmamış pasif hesaplar",
      amount: round2(liabOrphans.reduce((s, r) => s + sideAmount(r, "pasif"), 0)),
      lines: liabOrphans.map((r) => ({
        code: r.accountCode,
        name: r.accountName,
        amount: sideAmount(r, "pasif"),
      })),
    });
  }

  // Dönem sonucu özkaynağa eklenir. 590/591'e zaten aktarılmışsa
  // ORADA GÖRÜNÜR ve buraya ikinci kez eklenmez.
  const alreadyPosted = sheet.some(
    (r) => (r.accountCode === "590" || r.accountCode === "591") && r.balance !== 0,
  );
  const result = alreadyPosted ? 0 : round2(periodResult);
  if (result !== 0) {
    liabilities.push({
      code: "P",
      label: result >= 0 ? "Dönem Net Kârı" : "Dönem Net Zararı",
      amount: result,
      lines: [
        {
          code: result >= 0 ? "590" : "591",
          name: result >= 0 ? "Dönem Net Kârı" : "Dönem Net Zararı",
          amount: result,
        },
      ],
    });
  }

  const totalAssets = round2(assets.reduce((s, g) => s + g.amount, 0));
  const totalLiabilities = round2(liabilities.reduce((s, g) => s + g.amount, 0));
  const difference = round2(totalAssets - totalLiabilities);

  return {
    assets,
    liabilities,
    totalAssets,
    totalLiabilities,
    periodResult: round2(periodResult),
    // Kuruş farkı yuvarlamadan gelebilir; 0,01 toleransı gerçek bir
    // dengesizliği gizlemez ama yuvarlama gürültüsünü susturur.
    balanced: Math.abs(difference) < 0.011,
    difference,
  };
}
