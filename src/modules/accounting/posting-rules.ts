/**
 * Kayıt kuralları: hangi belge hangi hesaplara işler.
 *
 * KURALLAR BURADA, KODA GÖMÜLÜ DEĞİL. Fatura kesme kodunun içine
 * "120'ye borç, 600'e alacak" yazılsaydı, muhasebe mantığı beş ayrı
 * dosyaya dağılırdı; mali müşavir "bu kayıt neden böyle" diye sorduğunda
 * cevabı arayan kişi kodun tamamını okumak zorunda kalırdı. Tek dosyada
 * durması, denetlenebilir olması demektir.
 *
 * HER KURAL SAF BİR FONKSİYONDUR: belge verisini alır, fiş satırlarını
 * döndürür. Veritabanına dokunmaz, tarih üretmez. Böylece her kural
 * tek başına test edilebilir ve "şu fatura şu kaydı üretir" cümlesi
 * kanıtlanabilir olur.
 */

import { cogsAccountFor, stockAccountFor } from "./accounts.js";
import type { DraftLine } from "./journal.js";

/**
 * SATIŞ FATURASI.
 *
 *   120 Alıcılar            (B) toplam
 *       600 Yurtiçi Satışlar    (A) matrah
 *       391 Hesaplanan KDV      (A) KDV
 *
 * KDV AYRI SATIRDIR. Toplamı tek kalemde gelire yazmak, devlete ait olan
 * KDV'yi şirketin cirosu gibi gösterir ve hem kârı hem vergiyi bozar.
 */
export function salesInvoiceLines(inv: {
  documentNo: string;
  partnerId: string;
  netAmount: number;
  vatAmount: number;
  totalAmount: number;
  export?: boolean;
}): readonly DraftLine[] {
  const revenue = inv.export ? "601" : "600";
  const lines: DraftLine[] = [
    {
      accountCode: "120",
      debit: inv.totalAmount,
      credit: 0,
      description: `${inv.documentNo} satış faturası`,
      partnerId: inv.partnerId,
    },
    {
      accountCode: revenue,
      debit: 0,
      credit: inv.netAmount,
      description: `${inv.documentNo} satış`,
    },
  ];

  // KDV SIFIRSA SATIR YAZILMAZ. İhracatta ve bazı istisnalarda KDV yoktur;
  // sıfır tutarlı satır fişi uzatır ve okunmasını zorlaştırır.
  if (inv.vatAmount > 0) {
    lines.push({
      accountCode: "391",
      debit: 0,
      credit: inv.vatAmount,
      description: `${inv.documentNo} hesaplanan KDV`,
    });
  }
  return lines;
}

/**
 * SATILAN MALIN MALİYETİ — sevkiyatla birlikte.
 *
 *   620/621 Satılan ... Maliyeti  (B)
 *       150/152/153 Stok             (A)
 *
 * MALİYET SATIŞLA AYNI DÖNEME YAZILIR. Sevkiyatta yazılmasaydı, gelir
 * bu ay, maliyet gelecek ay düşer ve iki dönemin kârı da yanlış çıkardı
 * (dönemsellik ilkesi).
 *
 * MALİYETİ BİLİNMEYEN SEVKİYAT KAYIT ÜRETMEZ. Sıfır maliyetle yazılsaydı
 * o satış %100 kârlı görünürdü — sistemin verebileceği en pahalı yalan.
 */
export function cogsLines(shipment: {
  documentNo: string;
  itemType: string;
  value: number | null;
}): readonly DraftLine[] {
  if (shipment.value === null || shipment.value <= 0) return [];
  return [
    {
      accountCode: cogsAccountFor(shipment.itemType),
      debit: shipment.value,
      credit: 0,
      description: `${shipment.documentNo} satılan malın maliyeti`,
    },
    {
      accountCode: stockAccountFor(shipment.itemType),
      debit: 0,
      credit: shipment.value,
      description: `${shipment.documentNo} stok çıkışı`,
    },
  ];
}

/**
 * MAL KABULÜ (alış faturası).
 *
 *   150/153 Stok            (B) matrah
 *   191 İndirilecek KDV     (B) KDV
 *       320 Satıcılar           (A) toplam
 *
 * İNDİRİLECEK KDV STOK MALİYETİNE GİRMEZ. Girseydi stok değeri %20
 * şişer, satılan malın maliyeti de o oranda yanlış çıkardı — üstelik
 * indirilebilecek bir vergi indirilmemiş olurdu.
 */
export function goodsReceiptLines(receipt: {
  documentNo: string;
  partnerId: string;
  itemType: string;
  netAmount: number;
  vatAmount: number;
}): readonly DraftLine[] {
  const lines: DraftLine[] = [
    {
      accountCode: stockAccountFor(receipt.itemType),
      debit: receipt.netAmount,
      credit: 0,
      description: `${receipt.documentNo} mal kabulü`,
    },
  ];
  if (receipt.vatAmount > 0) {
    lines.push({
      accountCode: "191",
      debit: receipt.vatAmount,
      credit: 0,
      description: `${receipt.documentNo} indirilecek KDV`,
    });
  }
  lines.push({
    accountCode: "320",
    debit: 0,
    credit: receipt.netAmount + receipt.vatAmount,
    description: `${receipt.documentNo} satıcı borcu`,
    partnerId: receipt.partnerId,
  });
  return lines;
}

/**
 * ÖDEME.
 *
 *   Giden:  320 Satıcılar (B) / 102 Bankalar (A)
 *   Gelen:  102 Bankalar (B)  / 120 Alıcılar (A)
 *
 * Nakit ödeme 100 Kasa'ya, çek/senet ayrı hesaplara gider: "hangi
 * hesaptan çıktı" sorusu, "ne kadar çıktı" kadar önemlidir.
 */
export function paymentLines(payment: {
  documentNo: string;
  direction: "outgoing" | "incoming";
  partnerId: string;
  amount: number;
  method: string;
}): readonly DraftLine[] {
  const cash = cashAccountFor(payment.method, payment.direction);
  const partnerAccount = payment.direction === "outgoing" ? "320" : "120";

  return payment.direction === "outgoing"
    ? [
        {
          accountCode: partnerAccount,
          debit: payment.amount,
          credit: 0,
          description: `${payment.documentNo} tedarikçiye ödeme`,
          partnerId: payment.partnerId,
        },
        {
          accountCode: cash,
          debit: 0,
          credit: payment.amount,
          description: `${payment.documentNo} ${payment.method}`,
        },
      ]
    : [
        {
          accountCode: cash,
          debit: payment.amount,
          credit: 0,
          description: `${payment.documentNo} ${payment.method}`,
        },
        {
          accountCode: partnerAccount,
          debit: 0,
          credit: payment.amount,
          description: `${payment.documentNo} müşteriden tahsilat`,
          partnerId: payment.partnerId,
        },
      ];
}

/** Ödeme şekli hangi hesabı hareketlendirir. */
export function cashAccountFor(method: string, direction: "outgoing" | "incoming"): string {
  switch (method) {
    case "nakit":
      return "100";
    case "cek":
    case "senet":
      // Çek ve senet nakit değildir: verilen borç senedi, alınan alacak senedi.
      return direction === "outgoing" ? "321" : "121";
    default:
      return "102";
  }
}

/**
 * KUR FARKI.
 *
 *   Lehte:  ilgili hesap (B) / 646 Kambiyo Kârları (A)
 *   Aleyhte: 656 Kambiyo Zararları (B) / ilgili hesap (A)
 *
 * Kur farkı gelir ya da giderdir, satış değildir. 600'e yazılsaydı ciro
 * kurdan şişer ve büyüme rakamı yalan söylerdi.
 */
export function fxDifferenceLines(input: {
  description: string;
  accountCode: string;
  partnerId?: string | null;
  /** Pozitif: lehte (kâr). Negatif: aleyhte (zarar). */
  difference: number;
}): readonly DraftLine[] {
  if (input.difference === 0) return [];
  const amount = Math.abs(input.difference);
  const gain = input.difference > 0;

  return gain
    ? [
        {
          accountCode: input.accountCode,
          debit: amount,
          credit: 0,
          description: input.description,
          partnerId: input.partnerId ?? null,
        },
        { accountCode: "646", debit: 0, credit: amount, description: `${input.description} — kur farkı kârı` },
      ]
    : [
        { accountCode: "656", debit: amount, credit: 0, description: `${input.description} — kur farkı zararı` },
        {
          accountCode: input.accountCode,
          debit: 0,
          credit: amount,
          description: input.description,
          partnerId: input.partnerId ?? null,
        },
      ];
}

/**
 * STOK SAYIM FARKI.
 *
 *   Fazla:  stok (B) / 689 (A) — beklenmedik giriş bir kazanç değildir
 *   Eksik:  689 (B) / stok (A)
 *
 * 689 Diğer Olağandışı Gider ve Zararlar kullanılır: sayım farkı ne
 * satıştır ne maliyettir, olağandışıdır ve öyle görünmelidir. Maliyete
 * yazılsaydı, kaybolan mal satılmış gibi görünür ve fark gizlenirdi.
 */
export function stockCountDifferenceLines(input: {
  documentNo: string;
  itemType: string;
  /** Pozitif: sayımda fazla çıktı. Negatif: eksik. */
  valueDifference: number;
}): readonly DraftLine[] {
  if (input.valueDifference === 0) return [];
  const stock = stockAccountFor(input.itemType);
  const amount = Math.abs(input.valueDifference);
  const surplus = input.valueDifference > 0;

  return surplus
    ? [
        { accountCode: stock, debit: amount, credit: 0, description: `${input.documentNo} sayım fazlası` },
        { accountCode: "689", debit: 0, credit: amount, description: `${input.documentNo} sayım fazlası` },
      ]
    : [
        { accountCode: "689", debit: amount, credit: 0, description: `${input.documentNo} sayım eksiği` },
        { accountCode: stock, debit: 0, credit: amount, description: `${input.documentNo} sayım eksiği` },
      ];
}
