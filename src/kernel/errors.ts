/**
 * Tipli hata taksonomisi.
 *
 * Kural: hiçbir hata string eşleştirmesiyle yakalanmaz. Her hata bir sınıftır,
 * her sınıfın sabit bir `code`'u vardır ve `userFacing` alanı hatanın kullanıcıya
 * gösterilip gösterilemeyeceğini söyler. Yetki hataları kullanıcıya gösterilir
 * (Anayasa: "Bu bilgi için yetkiniz yok"), iç hatalar gösterilmez.
 */

export abstract class KaelonError extends Error {
  abstract readonly code: string;
  /** Kullanıcıya ham hâliyle gösterilebilir mi? */
  abstract readonly userFacing: boolean;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions);
    this.name = new.target.name;
    Error.captureStackTrace?.(this, new.target);
  }
}

/** Tool registry'de böyle bir tool yok. */
export class UnknownToolError extends KaelonError {
  readonly code = "unknown_tool";
  readonly userFacing = false;
  constructor(readonly toolName: string) {
    super(`Tanımsız tool: ${toolName}`);
  }
}

/** Kullanıcının bu tool'u çağırma izni yok. */
export class PermissionDeniedError extends KaelonError {
  readonly code = "permission_denied";
  readonly userFacing = true;
  constructor(
    readonly toolName: string,
    readonly missing: readonly string[],
  ) {
    super("Bu bilgi için yetkiniz yok. Yöneticinizden erişim talep edebilirsiniz.");
  }
}

/** Tool'un yetki seviyesi kullanıcının tavanını aşıyor. */
export class AuthorityExceededError extends KaelonError {
  readonly code = "authority_exceeded";
  readonly userFacing = true;
  constructor(
    readonly toolName: string,
    readonly required: number,
    readonly ceiling: number,
  ) {
    super("Bu işlem sizin yetki seviyenizin üzerinde. Onay akışı başlatılmalı.");
  }
}

/** Principal başka bir tenant'ın verisine ulaşmaya çalıştı. */
export class TenantMismatchError extends KaelonError {
  readonly code = "tenant_mismatch";
  readonly userFacing = false;
  constructor(readonly expected: string, readonly actual: string) {
    super(`Tenant uyuşmazlığı: ${expected} ≠ ${actual}`);
  }
}

/** Girdi şemaya uymadı. */
export class InputValidationError extends KaelonError {
  readonly code = "invalid_input";
  readonly userFacing = false;
  constructor(readonly toolName: string, readonly issues: readonly string[]) {
    super(`Geçersiz girdi (${toolName}): ${issues.join("; ")}`);
  }
}

/** İş kuralı ihlali — kullanıcıya açıklanabilir. */
export class BusinessRuleError extends KaelonError {
  readonly code = "business_rule";
  readonly userFacing = true;
  constructor(message: string, readonly rule: string) {
    super(message);
  }
}

/** Onaysız yürütülemeyecek bir işlem limitin üstünde. */
export class ApprovalRequiredError extends KaelonError {
  readonly code = "approval_required";
  readonly userFacing = true;
  constructor(message: string, readonly approvers: readonly string[]) {
    super(message);
  }
}

/**
 * Audit log yazılamadı.
 *
 * Yazma yapan tool'larda (L1+) bu hata isteği düşürür — "iz bırakmayan eylem
 * yoktur" ilkesi. Okuma tool'larında (L0) uyarı olarak geçilir.
 */
export class AuditWriteError extends KaelonError {
  readonly code = "audit_write_failed";
  readonly userFacing = false;
  constructor(cause: unknown) {
    super("Audit kaydı yazılamadı; yazma işlemi iptal edildi.", { cause });
  }
}

/** Tool'un execute'u beklenmedik biçimde patladı. */
export class ToolExecutionError extends KaelonError {
  readonly code = "tool_failed";
  readonly userFacing = false;
  constructor(readonly toolName: string, cause: unknown) {
    super(`Tool çalıştırılamadı: ${toolName}`, { cause });
  }
}

export function isKaelonError(e: unknown): e is KaelonError {
  return e instanceof KaelonError;
}

/** Herhangi bir hatayı kullanıcıya gösterilebilir güvenli mesaja indirger. */
export function toUserMessage(e: unknown): string {
  if (isKaelonError(e) && e.userFacing) return e.message;
  return "İşlem tamamlanamadı. Kayıt alındı, ilgili ekip bilgilendirildi.";
}
