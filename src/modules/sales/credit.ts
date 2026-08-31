/**
 * Kredi limiti kontrolü.
 *
 * RİSK ÜÇ PARÇADAN OLUŞUR ve üçü de sayılmak zorunda:
 *
 *   1. Vadesi geçmiş alacak — en ağırı; bu para gelmedi ve gecikti.
 *   2. Vadesi gelmemiş açık fatura — mal gitti, süre var.
 *   3. Sevk edilmemiş açık sipariş — henüz fatura yok ama taahhüt var.
 *
 * ÜÇÜNCÜSÜ EN ÇOK ATLANANI VE EN TEHLİKELİSİ. Yalnızca faturaya
 * bakan bir kontrol, aynı müşteriye arka arkaya beş sipariş
 * açılmasına izin verir; hiçbiri henüz faturalanmadığı için risk
 * "sıfır" görünür ve limit ancak mallar gittikten sonra dolar. O
 * noktada durdurmanın hiçbir faydası yoktur.
 *
 * ─────────────────────────────────────────────────────────────────
 *
 * LİMİT YOKSA "SINIRSIZ" DEĞİL "BELİRSİZ"DİR.
 *
 * null bir limiti sonsuz saymak kontrolü anlamsız kılar; sıfır
 * saymak her siparişi bloke eder. İkisi de sessiz bir varsayılandır
 * ve ikisi de yanlıştır. Kontrol "limit belirlenmemiş" der, riski
 * yine de hesaplar ve kararı insana bırakır.
 */

function kurusla(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface ExposurePart {
  readonly overdue: number;
  readonly openInvoices: number;
  readonly openOrders: number;
}

export interface CreditExposure {
  readonly partnerId: string;
  readonly partnerName: string;
  readonly currency: string;
  readonly parts: ExposurePart;
  readonly total: number;
  /** null = limit belirlenmemiş. */
  readonly limit: number | null;
  /** limit − risk. null = limit yok. Negatif = aşım. */
  readonly headroom: number | null;
  readonly blocked: boolean;
  readonly blockReason: string | null;
}

export type CreditDecision = "ok" | "warn" | "block";

export interface CreditCheck {
  readonly decision: CreditDecision;
  readonly exposure: CreditExposure;
  /** Kontrol edilen yeni sipariş tutarı. */
  readonly requestedAmount: number;
  /** Yeni sipariş dahil toplam risk. */
  readonly projectedTotal: number;
  readonly reason: string;
}

/** Limitin bu oranını geçen sipariş uyarı üretir. */
const UYARI_ESIGI = 0.9;

export function buildExposure(input: {
  partnerId: string;
  partnerName: string;
  currency: string;
  overdue: number;
  openInvoices: number;
  openOrders: number;
  limit: number | null;
  blocked: boolean;
  blockReason: string | null;
}): CreditExposure {
  const parts: ExposurePart = {
    overdue: kurusla(input.overdue),
    openInvoices: kurusla(input.openInvoices),
    openOrders: kurusla(input.openOrders),
  };
  const total = kurusla(parts.overdue + parts.openInvoices + parts.openOrders);
  return {
    partnerId: input.partnerId,
    partnerName: input.partnerName,
    currency: input.currency,
    parts,
    total,
    limit: input.limit,
    headroom: input.limit === null ? null : kurusla(input.limit - total),
    blocked: input.blocked,
    blockReason: input.blockReason,
  };
}

/**
 * Yeni bir sipariş bu cariye açılabilir mi.
 *
 * ÜÇ CEVAP, İKİ DEĞİL. "Evet/hayır" yetmez: limitin %90'ını geçen bir
 * sipariş engellenmemeli ama görülmelidir. Uyarı kademesi olmadan
 * satışçı ya hiç uyarılmaz ya da her seferinde engellenir.
 */
export function checkCredit(exposure: CreditExposure, requestedAmount: number): CreditCheck {
  const yeniToplam = kurusla(exposure.total + requestedAmount);

  /*
   * ELLE KONAN BLOK LİMİTTEN ÖNCE GELİR.
   *
   * Blok genellikle hukuki takip ya da ticari anlaşmazlık demektir
   * ve limitin dolup dolmamasıyla ilgisi yoktur. Sırayı tersine
   * çevirmek, limiti boş olan bloklu bir cariye satış yaptırırdı.
   */
  if (exposure.blocked) {
    return {
      decision: "block",
      exposure,
      requestedAmount: kurusla(requestedAmount),
      projectedTotal: yeniToplam,
      reason:
        `${exposure.partnerName} ticari olarak BLOKELİ: ${exposure.blockReason ?? "sebep kayıtlı değil"}. ` +
        `Blok kaldırılmadan sipariş açılamaz.`,
    };
  }

  if (exposure.limit === null) {
    return {
      decision: "warn",
      exposure,
      requestedAmount: kurusla(requestedAmount),
      projectedTotal: yeniToplam,
      reason:
        `${exposure.partnerName} için kredi limiti BELİRLENMEMİŞ. Mevcut risk ` +
        `${exposure.total} ${exposure.currency}, bu siparişle ${yeniToplam} olacak. ` +
        `Limit tanımlanmadan bu rakamın yüksek mi düşük mü olduğu söylenemez.`,
    };
  }

  if (yeniToplam > exposure.limit) {
    return {
      decision: "block",
      exposure,
      requestedAmount: kurusla(requestedAmount),
      projectedTotal: yeniToplam,
      reason:
        `Limit aşılıyor: mevcut risk ${exposure.total}, bu siparişle ${yeniToplam} ` +
        `olacak, limit ${exposure.limit} ${exposure.currency}. Aşım ` +
        `${kurusla(yeniToplam - exposure.limit)}.` +
        (exposure.parts.overdue > 0
          ? ` Riskin ${exposure.parts.overdue} kadarı VADESİ GEÇMİŞ alacak.`
          : ""),
    };
  }

  if (yeniToplam >= exposure.limit * UYARI_ESIGI) {
    return {
      decision: "warn",
      exposure,
      requestedAmount: kurusla(requestedAmount),
      projectedTotal: yeniToplam,
      reason:
        `Limit dolmak üzere: bu siparişle risk ${yeniToplam}, limit ${exposure.limit} ` +
        `${exposure.currency} (%${Math.round((yeniToplam / exposure.limit) * 100)}). ` +
        `Bir sonraki sipariş engellenebilir.`,
    };
  }

  return {
    decision: "ok",
    exposure,
    requestedAmount: kurusla(requestedAmount),
    projectedTotal: yeniToplam,
    reason:
      `Limit içinde: bu siparişle risk ${yeniToplam}, limit ${exposure.limit} ` +
      `${exposure.currency}. Kalan ${kurusla(exposure.limit - yeniToplam)}.`,
  };
}
