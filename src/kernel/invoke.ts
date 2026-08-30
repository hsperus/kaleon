/**
 * Tool invoker — yedi katmanın sırayla ve İSTİSNASIZ çalıştığı tek yer.
 *
 * UI, AI, mobil ve API bu fonksiyondan geçer. Başka bir giriş yoktur;
 * `tool.execute` doğrudan çağrılmaz. Bu disiplin sayesinde yetki kontrolü,
 * doğrulama ve audit kaydı atlanamaz.
 */

import type { z } from "zod";
import type { Channel, Principal, TenantContext, ToolContext, ToolOutcome } from "./types.js";
import type { Tool } from "./tool.js";
import type { ToolRegistry } from "./registry.js";
import type { AuditSink } from "./audit.js";
import { buildEntry } from "./audit.js";
import { assertAuthority } from "./authority.js";
import { missingPermissions } from "./rbac.js";
import {
  PENDING_TTL_MS,
  requiresConfirmation,
  type ConfirmationRequired,
  type PendingStore,
} from "./pending.js";
import {
  AuditWriteError,
  InputValidationError,
  KaelonError,
  PermissionDeniedError,
  TenantMismatchError,
  BusinessRuleError,
  ToolExecutionError,
  UnknownToolError,
  isKaelonError,
} from "./errors.js";

export interface InvokeOptions {
  readonly registry: ToolRegistry;
  readonly audit: AuditSink;
  readonly principal: Principal;
  readonly tenant: TenantContext;
  readonly correlationId: string;
  readonly channel: Channel;
  readonly now?: () => Date;
  readonly newId?: () => string;
  readonly aiContext?: { model: string; promptVersion: string; toolUseId: string };
  /**
   * Onay bekleyen işlem deposu.
   *
   * VERİLMEZSE YAZMA TOOL'LARI ÇALIŞMAZ. "Depo yoksa onayı atla" davranışı
   * cazip ama yanlış olurdu: bir yapılandırma eksikliği, insan onayını
   * sessizce devre dışı bırakırdı. Eksiklik hata olarak görünmelidir.
   */
  readonly pending?: PendingStore;
  /**
   * Kullanıcı bu işlemi ONAYLADI. Yalnızca `confirmPendingAction`
   * tarafından verilir; dışarıdan gelen bir istekte asla true olmaz.
   */
  readonly confirmed?: boolean;
  readonly conversationId?: string | null;
}

export interface InvokeResult {
  readonly outcome: ToolOutcome<unknown>;
  readonly durationMs: number;
  readonly toolName: string;
}

/** Audit özeti — ham veri değil, boyut ve kaynak bilgisi. */
function summarize(outcome: ToolOutcome<unknown>): unknown {
  if (!outcome.ok) return { ok: false, code: outcome.code };
  const data = outcome.data;
  return {
    ok: true,
    shape: Array.isArray(data) ? `array(${data.length})` : typeof data,
    sources: outcome.sources.map((s) => s.system),
    riskCount: outcome.risks?.length ?? 0,
    ...(outcome.confidence !== undefined ? { confidence: outcome.confidence } : {}),
  };
}


/**
 * Anlamı olan veritabanı hataları.
 *
 * Yalnızca KULLANICININ ya da MODELİN düzeltebileceği olanlar burada.
 * Bağlantı hatası, kilit zaman aşımı gibi sistem sorunları
 * çevrilmez — onlar kullanıcının yapabileceği bir şey değildir.
 */
const PRISMA_MESSAGES: Readonly<Record<string, string>> = {
  P2023:
    "Bu alan bir KİMLİK (UUID) bekliyor; ad ya da kod kabul etmiyor. Önce " +
    "arama/çözümleme tool'uyla kaydın kimliğini bulun, sonra tekrar deneyin.",
  P2025: "Aranan kayıt bulunamadı.",
  P2003: "Bağlı bir kayıt bulunamadı; önce ona ait kaydın var olduğundan emin olun.",
};

/**
 * Alan hatasını kullanıcıya görünür hâle çevirir.
 *
 * BU PROJEDEKİ TÜM ALAN HATALARI DÜZ `Error`'DAN TÜRÜYOR ve `code`
 * alanı taşıyor: `DocumentFlowError`, `EInvoiceError`, `LeaveError`,
 * `BatchError`, `JournalError`… Çekirdek onları tanımadığı için
 * hepsini `ToolExecutionError` ile sarıyordu ve kullanıcı şunu
 * görüyordu:
 *
 *   "Tool çalıştırılamadı: get_invoice_document"
 *
 * Oysa hata şunu diyordu: "Fatura bulunamadı: FTR-9999". Yani sistem
 * kullanıcıya yanlış numara yazdığını değil, KENDİSİNİN BOZUK
 * OLDUĞUNU söylüyordu. Duman testinde 8 tool bu yüzden "arızalı"
 * göründü; hiçbiri arızalı değildi.
 *
 * Tek tek 15 hata sınıfını değiştirmek yerine kural burada: `code`
 * taşıyan bir hata, o modülün bilerek yazdığı bir mesajdır ve
 * kullanıcıya aittir. `code` taşımayan hata (TypeError, bağlantı
 * hatası) içeride kalır — iç detay sızdırmak da bir hatadır.
 */
function asDomainError(e: unknown, toolName: string): BusinessRuleError | null {
  if (!(e instanceof Error)) return null;
  if (e instanceof KaelonError) return null;
  const code = (e as { code?: unknown }).code;
  if (typeof code !== "string" || code.length === 0) return null;

  /*
   * VERİTABANI HATASI DA BİR CEVAPTIR — DOĞRU ÇEVRİLİRSE.
   *
   * Model, kimlik bekleyen bir alana çoğu zaman ADI ya da KODU
   * gönderir: "Daimler'e fatura kesilebilir mi?" sorusunda
   * `partnerId` alanına "Daimler" yazar. Alan UUID olduğu için
   * Prisma P2023 fırlatır ve kullanıcı "Tool çalıştırılamadı"
   * görürdü — model de neyi yanlış yaptığını anlamadığı için aynı
   * hatayı tekrar ederdi.
   *
   * Çeviri, hem kullanıcıya hem MODELE ne yapması gerektiğini söyler.
   */
  const prisma = PRISMA_MESSAGES[code];
  if (prisma) return new BusinessRuleError(prisma, code);

  // Diğer Postgres/Node hataları içeride kalır: iç detay sızdırmak da
  // bir hatadır.
  if (/^[A-Z][0-9]{4}$/.test(code) || /^E[A-Z]+$/.test(code)) return null;
  const message = e.message.trim();
  if (message.length === 0 || message.length > 400) return null;
  void toolName;
  return new BusinessRuleError(message, code);
}

export async function invokeTool(
  toolName: string,
  rawInput: unknown,
  opts: InvokeOptions,
): Promise<InvokeResult> {
  const now = opts.now ?? (() => new Date());
  const newId = opts.newId ?? (() => globalThis.crypto.randomUUID());
  const startedAt = now();
  const t0 = Date.now();

  const tool = opts.registry.get(toolName) as Tool<z.ZodType, unknown> | undefined;

  // Audit her yoldan yazılır; bu closure tek yazma noktasıdır.
  const write = async (
    outcome: Parameters<typeof buildEntry>[0]["outcome"],
    extra: { resultSummary?: unknown; errorCode?: string },
  ): Promise<void> => {
    const entry = buildEntry({
      id: newId(),
      principal: opts.principal,
      channel: opts.channel,
      correlationId: opts.correlationId,
      toolName,
      authority: tool?.authority ?? 0,
      outcome,
      input: rawInput,
      durationMs: Date.now() - t0,
      at: startedAt,
      ...extra,
      ...(opts.aiContext ? { aiContext: opts.aiContext } : {}),
    });
    try {
      await opts.audit.append(entry);
    } catch (cause) {
      // Yazan tool'da audit hatası işlemi düşürür; okuyanda geçilir.
      if ((tool?.authority ?? 0) > 0) throw new AuditWriteError(cause);
    }
  };

  const fail = async (e: KaelonError, kind: "denied" | "invalid" | "failed") => {
    await write(kind, { errorCode: e.code });
    return {
      outcome: { ok: false as const, code: e.code, message: e.message, userFacing: e.userFacing },
      durationMs: Date.now() - t0,
      toolName,
    };
  };

  // ── 1. Tool var mı?
  if (!tool) return fail(new UnknownToolError(toolName), "failed");

  // ── 2. Tenant izolasyonu
  if (opts.principal.tenantId !== opts.tenant.tenantId) {
    return fail(
      new TenantMismatchError(opts.tenant.tenantId, opts.principal.tenantId),
      "denied",
    );
  }

  // ── 3. Authorization: izin + yetki tavanı
  const missing = missingPermissions(opts.principal, tool.requires);
  if (missing.length > 0) {
    return fail(new PermissionDeniedError(toolName, missing), "denied");
  }
  try {
    assertAuthority(toolName, tool.authority, opts.principal);
  } catch (e) {
    if (isKaelonError(e)) return fail(e, "denied");
    throw e;
  }

  // ── 4. Girdi şeması
  const parsed = tool.input.safeParse(rawInput);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(kök)"}: ${i.message}`);
    return fail(new InputValidationError(toolName, issues), "invalid");
  }

  const ctx: ToolContext = {
    principal: opts.principal,
    tenant: opts.tenant,
    correlationId: opts.correlationId,
    channel: opts.channel,
    now,
  };

  // ── 5. İş kuralı doğrulaması
  try {
    await tool.validate?.(parsed.data, ctx);
  } catch (e) {
    if (isKaelonError(e)) return fail(e, "denied");
    const domain = asDomainError(e, toolName);
    if (domain) return fail(domain, "failed");
    return fail(new ToolExecutionError(toolName, e), "failed");
  }

  // ── 6. İnsan onayı
  //
  // Bu kapı sistem promptunda DEĞİL burada durur. Promptta olsaydı, kuralın
  // uygulanması modelin talimata uymasına bağlı kalırdı; burada, invoker'ın
  // çalışma şartıdır ve UI, AI, mobil ve API için aynıdır.
  if (!opts.confirmed && requiresConfirmation(tool)) {
    if (!opts.pending) {
      return fail(
        new ToolExecutionError(
          toolName,
          new Error(
            "Onay deposu yapılandırılmamış; yazma işlemi onaysız çalıştırılamaz.",
          ),
        ),
        "failed",
      );
    }

    const pendingId = newId();
    const expiresAt = new Date(startedAt.getTime() + PENDING_TTL_MS);
    await opts.pending.create({
      id: pendingId,
      toolName,
      // DOĞRULANMIŞ girdi saklanır, ham girdi değil: onay ekranı modelin
      // yazdığını değil, sistemin anladığını göstermelidir.
      input: parsed.data,
      authority: tool.authority,
      userId: opts.principal.userId,
      correlationId: opts.correlationId,
      conversationId: opts.conversationId ?? null,
      createdAt: startedAt,
      expiresAt,
    });

    const outcome: ConfirmationRequired = {
      ok: false,
      code: "confirmation_required",
      message:
        `"${toolName}" işlemi hazırlandı ve ONAYINIZI BEKLİYOR. Alanları ` +
        `kontrol edip gönderene kadar hiçbir kayıt oluşmaz.`,
      userFacing: true,
      pendingId,
      toolName,
      input: parsed.data,
      authority: tool.authority,
      expiresAt: expiresAt.toISOString(),
    };

    await write("pending", { errorCode: "confirmation_required" });
    return { outcome, durationMs: Date.now() - t0, toolName };
  }

  // ── 7. Çalıştırma
  let outcome: ToolOutcome<unknown>;
  try {
    const ok = await tool.execute(parsed.data, ctx);
    const data = tool.redact ? tool.redact(ok.data, opts.principal) : ok.data;
    outcome = { ...ok, data };
  } catch (e) {
    if (isKaelonError(e)) return fail(e, "failed");
    const domain = asDomainError(e, toolName);
    if (domain) return fail(domain, "failed");
    return fail(new ToolExecutionError(toolName, e), "failed");
  }

  // ── 8. Audit + cevap
  await write("success", { resultSummary: summarize(outcome) });
  return { outcome, durationMs: Date.now() - t0, toolName };
}

/**
 * Kullanıcının onayladığı işlemi çalıştırır.
 *
 * GİRDİ ONAY ANINDA DEĞİŞTİRİLEBİLİR ama KONTROLLER TEKRAR ÇALIŞIR: form
 * yeniden şemadan geçer, yetki yeniden kontrol edilir, iş kuralı yeniden
 * doğrulanır. Onaylanmış bir işlem "artık serbest" demek değildir; onay,
 * yalnızca kapıyı açar.
 *
 * İŞLEM ÖNCE TÜKETİLİR, SONRA ÇALIŞTIRILIR. Ters sırada olsaydı, iki
 * eşzamanlı onay isteği de çalışır ve aynı fatura iki kez kesilirdi.
 * Çalıştırma iş kuralına takılırsa hiçbir kayıt oluşmadığı için işlem
 * yeniden bekler hâle getirilir — kullanıcı bir alanı düzeltip tekrar
 * gönderebilsin diye.
 */
export async function confirmPendingAction(
  pendingId: string,
  editedInput: unknown,
  opts: InvokeOptions & { pending: PendingStore },
): Promise<InvokeResult> {
  const now = opts.now ?? (() => new Date());
  const action = await opts.pending.find(pendingId, opts.principal.userId);

  if (!action) {
    return {
      outcome: {
        ok: false,
        code: "pending_not_found",
        message:
          "Onay bekleyen işlem bulunamadı. Başkası tarafından hazırlanmış olabilir " +
          "ya da işlemin süresi dolmuştur.",
        userFacing: true,
      },
      durationMs: 0,
      toolName: "",
    };
  }

  if (action.status !== "pending") {
    return {
      outcome: {
        ok: false,
        code: "pending_already_used",
        message:
          action.status === "confirmed"
            ? "Bu işlem zaten onaylanmış; ikinci kez çalıştırılamaz."
            : `Bu işlem ${action.status === "cancelled" ? "iptal edilmiş" : "süresi dolmuş"}.`,
        userFacing: true,
      },
      durationMs: 0,
      toolName: action.toolName,
    };
  }

  const consumed = await opts.pending.consume(pendingId, opts.principal.userId, now());
  if (!consumed) {
    return {
      outcome: {
        ok: false,
        code: "pending_already_used",
        message: "Bu işlem az önce onaylandı veya süresi doldu; tekrar çalıştırılmadı.",
        userFacing: true,
      },
      durationMs: 0,
      toolName: action.toolName,
    };
  }

  // Kullanıcı formu değiştirmediyse hazırlanan girdi kullanılır.
  const input = editedInput === undefined ? action.input : editedInput;

  const result = await invokeTool(action.toolName, input, { ...opts, confirmed: true });

  // Yazma gerçekleşmediyse işlem yeniden onaylanabilir olmalı.
  if (!result.outcome.ok) {
    await opts.pending.release(pendingId, opts.principal.userId);
  }

  return result;
}
