/**
 * Onay bekleyen işlemler — "AI hazırlar, sistem doğrular, İNSAN ONAYLAR"
 * zincirinin son halkası.
 *
 * BU KURAL PROMPTLA KORUNAMAZ. Sistem promptunda "kesmeden önce onay al"
 * yazmak, kuralı modelin talimata uymasına bağlar. Model yanılırsa,
 * kullanıcı yanlış anlaşılırsa ya da bir jailbreak denemesi geçerse fatura
 * kesilmiş olur ve geri alınamaz. Onay YAPISAL olmalıdır: yazma tool'u
 * kullanıcı açıkça onaylamadan ÇALIŞMAZ, çünkü invoker onu çalıştırmaz.
 *
 * BEKLEYEN İŞLEM VERİTABANINDA DURUR, BELLEKTE DEĞİL. Bellekte dursaydı
 * sunucu yeniden başladığında ya da ikinci bir örneğe düşen istekte
 * kaybolurdu; kullanıcı "onayla"ya bastığında hiçbir şey olmazdı.
 *
 * ÜÇ BAĞ VE BİR SÜRE:
 *   kullanıcıya bağlı  — başkasının hazırladığı işlemi onaylayamazsınız
 *   tenant'a bağlı     — şirket sınırı burada da geçerlidir
 *   TEK KULLANIMLIK    — onaylanan işlem tekrar oynatılamaz
 *   süreli             — yarım kalmış bir onay yarın tetiklenmemelidir
 *
 * GİRDİ ONAY ANINDA DEĞİŞTİRİLEBİLİR. Form salt okunur olsaydı, modelin
 * yanlış doldurduğu bir alanı düzeltmek için baştan anlatmak gerekirdi.
 * Değiştirilen girdi yeniden doğrulanır ve yeniden yetkilendirilir —
 * onay, kontrolü gevşetmez.
 */

import type { AuthorityLevel } from "./types.js";

/** Onay bekleyen işlemin durumu. */
export const PENDING_STATUSES = ["pending", "confirmed", "cancelled", "expired"] as const;
export type PendingStatus = (typeof PENDING_STATUSES)[number];

/** Bekleyen işlemin yaşam süresi. */
export const PENDING_TTL_MS = 15 * 60 * 1000;

export interface PendingAction {
  readonly id: string;
  readonly toolName: string;
  /** Modelin doldurduğu girdi — kullanıcı onay ekranında düzeltebilir. */
  readonly input: unknown;
  readonly authority: AuthorityLevel;
  readonly userId: string;
  readonly correlationId: string;
  readonly conversationId: string | null;
  readonly status: PendingStatus;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface PendingStore {
  create(action: {
    id: string;
    toolName: string;
    input: unknown;
    authority: AuthorityLevel;
    userId: string;
    correlationId: string;
    conversationId?: string | null;
    createdAt: Date;
    expiresAt: Date;
  }): Promise<void>;

  /** Yalnızca o kullanıcının BEKLEYEN işlemi. Başkasınınki görünmez. */
  find(id: string, userId: string): Promise<PendingAction | null>;

  /**
   * İşlemi tüketir: `pending` → `confirmed`. YARIŞA KAPALI olmalıdır —
   * iki eşzamanlı onay isteğinden yalnızca biri true dönmeli, aksi hâlde
   * aynı fatura iki kez kesilir.
   */
  consume(id: string, userId: string, now: Date): Promise<boolean>;

  cancel(id: string, userId: string): Promise<boolean>;

  /**
   * Tüketilmiş bir işlemi yeniden bekler hâle getirir.
   *
   * Onaylanan işlem çalışırken bir İŞ KURALINA takılırsa (kalan miktar
   * yetmiyor, dönem kapalı…) hiçbir kayıt oluşmamıştır. Bu durumda işlemi
   * tüketilmiş bırakmak, kullanıcıyı formu baştan doldurmaya zorlardı —
   * oysa yapması gereken tek şey bir alanı düzeltmek.
   *
   * Yarışa açık değildir: yalnızca tüketen istek serbest bırakabilir.
   */
  release(id: string, userId: string): Promise<void>;

  /** Kullanıcının bekleyen işlemleri — arayüz açılışta bunları gösterir. */
  listPending(userId: string, now: Date): Promise<readonly PendingAction[]>;

  /** Süresi dolanları temizler; bakım görevinden çağrılır. */
  expire(now: Date): Promise<number>;
}

/** Onay gerekiyor cevabı — hata DEĞİL, akışın bir adımı. */
export interface ConfirmationRequired {
  readonly ok: false;
  readonly code: "confirmation_required";
  readonly message: string;
  readonly userFacing: true;
  readonly pendingId: string;
  readonly toolName: string;
  readonly input: unknown;
  readonly authority: AuthorityLevel;
  readonly expiresAt: string;
}

export function isConfirmationRequired(
  outcome: { ok: boolean; code?: string } | null | undefined,
): outcome is ConfirmationRequired {
  return outcome?.ok === false && outcome.code === "confirmation_required";
}

/**
 * Bu tool onay gerektirir mi.
 *
 * OKUMA ONAY İSTEMEZ (L0): her bakiye sorgusunda "onaylıyor musunuz"
 * sormak, onayı anlamsız bir tıklamaya çevirir ve gerçekten bakılması
 * gereken işlem de o gürültünün içinde kaybolur.
 *
 * YAZMANIN TAMAMI ONAY İSTER (L1+). Sınırı L2'ye çekmek cazipti — "malzeme
 * kartı açmak zararsız" denebilirdi. Ama L1 tool'ları da ana veriyi
 * değiştirir ve asıl mesele şudur: onay ekranı aynı zamanda VERİ GİRİŞ
 * FORMUDUR. Depo sorumlusunun cümle kurarak irsaliye kesmesi, form
 * doldurmasından yavaş ve hatalıdır.
 */
export function requiresConfirmation(tool: {
  authority: AuthorityLevel;
  confirm?: "always" | "never";
}): boolean {
  if (tool.confirm === "never") return false;
  if (tool.confirm === "always") return true;
  return tool.authority >= 1;
}
