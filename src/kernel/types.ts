/**
 * KAELON çekirdek tipleri.
 *
 * Buradaki en önemli karar tek satırda: `AuthorityLevel` L4'ü İÇERMEZ.
 * L4 (resmî gönderim, ödeme talimatı, yetki yükseltme) bir prompt talimatı
 * değil, tip sisteminde bir yokluktur. L4 bir tool olarak tanımlanamaz;
 * dolayısıyla model onu çağıramaz — jailbreak edilse bile.
 */

/** Yetki seviyesi. L4 kasıtlı olarak yoktur — bkz. dosya başı. */
export type AuthorityLevel =
  /** L0 — sadece okur, sistemi değiştirmez. */
  | 0
  /** L1 — taslak üretir, commit etmez. */
  | 1
  /** L2 — onay akışı başlatır. */
  | 2
  /** L3 — yetki limitleri içinde düşük riskli işlem. */
  | 3;

export const AUTHORITY_LABEL: Record<AuthorityLevel, string> = {
  0: "L0 · okuma",
  1: "L1 · taslak",
  2: "L2 · onaya gönderim",
  3: "L3 · sınırlı işlem",
};

export type ModuleId =
  | "master-data"
  | "documents"
  | "finance"
  | "accounting"
  | "operations"
  | "inventory"
  | "maintenance"
  | "hr"
  | "sales"
  | "quality"
  | "approval"
  /**
   * Platform yönetimi — kullanıcı, rol, 2FA, oturum.
   *
   * İş modülü DEĞİLDİR ve bilinçli olarak ayrıdır: "finance:*" jokeri alan
   * bir CFO, kullanıcı yönetimine erişmemelidir. Yetkiyi kendi kendine
   * yükseltebilen bir rol, rol sisteminin kendisini anlamsız kılar.
   */
  | "admin"
  /**
   * Açılış brifingi ve kullanıcı tanımlı izlemeler.
   *
   * AYRI BİR MODÜL ÇÜNKÜ İZLEME BİR VERİ DEĞİL, DAVRANIŞTIR. İzlenen
   * verinin izni ayrıca kontrol edilir (izleme sahibinin o tool'u
   * çalıştırma yetkisi olmalıdır); buradaki izin, kişinin kendine
   * kalıcı uyarı kurup kuramayacağını belirler.
   */
  | "briefing";

/** `modul:kaynak.eylem` — örn. "finance:bank.read" */
export type Permission = `${ModuleId}:${string}`;

export type RoleId =
  | "patron"
  | "cfo"
  | "ik_muduru"
  | "uretim_muduru"
  | "satin_alma"
  | "depo_sorumlusu"
  | "operator";

/** İsteği yapan kimlik. Her tool çağrısı bir principal ile yapılır. */
export interface Principal {
  readonly userId: string;
  readonly tenantId: string;
  readonly roles: readonly RoleId[];
  /** Rollerden türetilmiş, çözülmüş izin kümesi. */
  readonly permissions: ReadonlySet<Permission>;
  /** Bu kullanıcının çağırabileceği en yüksek yetki seviyesi. */
  readonly maxAuthority: AuthorityLevel;
  /** Onaysız başlatılabilecek işlem üst sınırı (L3 için). */
  readonly approvalLimit?: Money;
}

export interface TenantContext {
  readonly tenantId: string;
  /** schema-per-tenant izolasyonu (Mimari v1 §6.2). */
  readonly schema: string;
  readonly locale: string;
  readonly baseCurrency: string;
}

export interface Money {
  readonly amount: number;
  readonly currency: string;
}

/**
 * Bir cevabın kaynağı. Tool sonucunun zorunlu parçasıdır —
 * "her cevap kaynak gösterir" kuralı promptla değil, tiple uygulanır.
 */
export interface SourceRef {
  /** İnsan tarafından okunabilir kaynak adı — "Uyumsoft e-Fatura" */
  readonly system: string;
  readonly kind: "integrator" | "module" | "machine" | "manual" | "derived";
  /** Cevabın dayandığı kayıt sayısı. */
  readonly recordCount?: number;
  /** Kaynağın en son ne zaman senkronize edildiği (ISO 8601). */
  readonly syncedAt: string;
}

export interface Risk {
  readonly severity: "info" | "warning" | "critical";
  readonly message: string;
  /** Riskin dayandığı kayıtlara drilldown anahtarı. */
  readonly ref?: string;
}

export interface NextAction {
  readonly label: string;
  /** Önerilen bir sonraki tool — registry'de var olmak zorundadır. */
  readonly tool: string;
  readonly input?: Record<string, unknown>;
}

/** Başarılı tool sonucu. Kaynak zorunlu, risk ve öneri opsiyoneldir. */
export interface ToolOk<T> {
  readonly ok: true;
  readonly data: T;
  readonly sources: readonly SourceRef[];
  readonly risks?: readonly Risk[];
  readonly nextActions?: readonly NextAction[];
  /** 0-100. Veri eksikse model bunu cevaba yansıtmak zorundadır. */
  readonly confidence?: number;
}

export interface ToolFail {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  /** Kullanıcıya gösterilebilir mi, yoksa sadece log'a mı? */
  readonly userFacing: boolean;
}

export type ToolOutcome<T> = ToolOk<T> | ToolFail;

/** Tool çalıştırma bağlamı — execute ve validate'e verilir. */
export interface ToolContext {
  readonly principal: Principal;
  readonly tenant: TenantContext;
  /** Aynı konuşmadaki tüm tool çağrılarını bağlayan kimlik. */
  readonly correlationId: string;
  /** Çağrının geldiği kanal — audit log'a düşer. */
  readonly channel: Channel;
  /** Deterministik zaman kaynağı (test edilebilirlik + önbellek güvenliği). */
  readonly now: () => Date;
}

export type Channel = "chat" | "ui" | "api" | "mobile" | "shopfloor" | "job";
