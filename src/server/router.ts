/**
 * KAELON API yüzeyi.
 *
 * Dikkat: burada iş kuralı YOKTUR. Her uç nokta ya `invokeTool` ya
 * `runConversation` çağırır; ikisi de yetki, doğrulama ve audit'ten geçer.
 * API katmanına iş kuralı sızarsa, UI ve AI farklı davranmaya başlar.
 */

import { TRPCError } from "@trpc/server";
import * as admin from "./admin.js";
import { holds, missingPermissions } from "../kernel/rbac.js";

/**
 * Yönetim hatalarını tRPC hatasına çevirir.
 *
 * `AdminError` kullanıcıya GÖSTERİLEBİLİR bir mesaj taşır ("Kendi patron
 * rolünüzü kaldıramazsınız"). Beklenmeyen hatalar olduğu gibi yükselir ve
 * genel hata yoluna düşer — iç ayrıntı sızmaz.
 */
async function adminCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof admin.AdminError) {
      throw new TRPCError({ code: "FORBIDDEN", message: e.message });
    }
    throw e;
  }
}
import { z } from "zod";
import { procedure, router } from "./trpc.js";
import { runConversation } from "../ai/runner.js";
import { confirmPendingAction } from "../kernel/invoke.js";
import { TOOL_LABELS, actionLabel } from "../ai/tool-labels.js";
import { MODEL_CONNECTED, ROLE_LABEL } from "./context.js";
import { GOLDEN_QUESTIONS } from "../eval/golden.js";
import { buildBriefing } from "../modules/briefing/engine.js";

export const appRouter = router({
  /** Oturum bilgisi: kim, hangi rolde, hangi tool'ları görebiliyor. */
  session: procedure.query(({ ctx }) => {
    const catalog = ctx.registry.catalogFor(ctx.principal);
    return {
      userId: ctx.principal.userId,
      roles: ctx.principal.roles,
      roleLabel: ROLE_LABEL[ctx.principal.roles[0]!],
      maxAuthority: ctx.principal.maxAuthority,
      tenant: ctx.tenant.tenantId,
      visibleTools: catalog.names,
      totalTools: ctx.registry.size,
      modelConnected: MODEL_CONNECTED,
      identitySource: ctx.identitySource,
      dataPlane: ctx.dataPlane,
      displayName: ctx.displayName,
      companyName: ctx.companyName,
      // Arayüz yönetim düğmesini bu bayrağa göre gösterir. Yetki kontrolü
      // yine sunucuda; bayrak yalnızca gereksiz bir düğmeyi gizler.
      canManageUsers: holds(ctx.principal, "admin:user.manage"),
    };
  }),

  /** Doğal dil sorgusu — ajan döngüsünü çalıştırır. */
  ask: procedure
    .input(z.object({ question: z.string().min(2).max(2000) }))
    .mutation(async ({ ctx, input }) => {
      const result = await runConversation(
        { gateway: ctx.completer, registry: ctx.registry, audit: ctx.audit },
        {
          question: input.question,
          principal: ctx.principal,
          tenant: ctx.tenant,
          correlationId: crypto.randomUUID(),
          channel: ctx.channel,
          task: "lookup",
          display: {
            name: "Cebrail Karaarslan",
            roleLabel: ROLE_LABEL[ctx.principal.roles[0]!],
            companyName: "Orthaus",
          },
          pending: ctx.pending,
        },
      );
      return result;
    }),

  /**
   * Onay bekleyen işlemler.
   *
   * Arayüz açılışta bunu okur: yarım kalmış bir onay, sayfa yenilendiğinde
   * kaybolmamalıdır — kullanıcı hazırladığı faturayı bulamazsa baştan
   * anlatmak zorunda kalır.
   */
  pendingActions: procedure.query(async ({ ctx }) => {
    const rows = await ctx.pending.listPending(ctx.principal.userId, new Date());
    return rows.map((r) => ({
      id: r.id,
      tool: r.toolName,
      label: actionLabel(r.toolName),
      input: r.input,
      authority: r.authority,
      expiresAt: r.expiresAt,
      schema: ctx.registry.get(r.toolName)?.schema.input_schema ?? null,
      description: ctx.registry.get(r.toolName)?.description.tr ?? null,
    }));
  }),

  /**
   * Bir tool'un girdi şeması — FORMUN KAYNAĞI.
   *
   * Ayrı bir form tanımı tutmuyoruz: tool'un zod şeması zaten alanları,
   * tiplerini, zorunluluklarını ve Türkçe açıklamalarını içeriyor. İkinci
   * bir tanım tutulsaydı, tool değişip form değişmediğinde kullanıcı
   * olmayan bir alanı doldurmaya çalışırdı.
   */
  toolSchema: procedure
    .input(z.object({ tool: z.string().min(1).max(64) }))
    .query(({ ctx, input }) => {
      const tool = ctx.registry.get(input.tool);
      // YETKİSİ OLMAYAN ŞEMAYI DA GÖREMEZ: şema, sistemin ne yapabildiğini
      // anlatır ve kullanıcının göremediği yeteneği ifşa etmemelidir.
      if (!tool || missingPermissions(ctx.principal, tool.requires).length > 0) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Tool bulunamadı." });
      }
      return {
        name: tool.name,
        label: actionLabel(tool.name),
        authority: tool.authority,
        description: tool.description.tr,
        schema: tool.schema.input_schema,
      };
    }),

  /**
   * Onaylanan işlemi çalıştırır.
   *
   * Girdi burada DEĞİŞTİRİLEBİLİR — form salt okunur olsaydı, modelin
   * yanlış doldurduğu bir alanı düzeltmek için baştan anlatmak gerekirdi.
   * Değiştirilen girdi yeniden şemadan geçer ve yeniden yetkilendirilir.
   */
  confirmAction: procedure
    .input(z.object({ pendingId: z.string().uuid(), input: z.unknown() }))
    .mutation(async ({ ctx, input }) => {
      const result = await confirmPendingAction(input.pendingId, input.input, {
        registry: ctx.registry,
        audit: ctx.audit,
        principal: ctx.principal,
        tenant: ctx.tenant,
        correlationId: crypto.randomUUID(),
        channel: ctx.channel,
        pending: ctx.pending,
      });
      return {
        tool: result.toolName,
        label: TOOL_LABELS[result.toolName] ?? result.toolName,
        outcome: result.outcome,
      };
    }),

  /** Onay bekleyen işlemi iptal eder — hiçbir kayıt oluşmaz. */
  cancelAction: procedure
    .input(z.object({ pendingId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => ({
      cancelled: await ctx.pending.cancel(input.pendingId, ctx.principal.userId),
    })),

  /**
   * Boss Mode brifingi.
   *
   * Ekranın doluluğu buradan gelir — sabit metin değil, eşik hesabı.
   * Nöbetçiler kullanıcının kendi yetkisiyle koşar; rol değişince hem
   * koşan nöbetçiler hem çıkan sinyaller değişir.
   */
  briefing: procedure.query(async ({ ctx }) => {
    const b = await buildBriefing(
      // İzleme deposu brifinge verilir: kullanıcının kendi kurduğu
      // uyarılar yerleşik nöbetçilerle aynı ekranda çıkar.
      { registry: ctx.registry, audit: ctx.audit, watches: ctx.watches },
      {
        principal: ctx.principal,
        tenant: ctx.tenant,
        correlationId: crypto.randomUUID(),
        channel: "job",
      },
    );
    return {
      level: b.level,
      signals: b.signals,
      ran: b.ran,
      // ÇALIŞAMAYAN İZLEME SESSİZ KALMAZ.
      brokenWatches: b.brokenWatches,
      skipped: b.skippedByPermission,
    };
  }),

  /** Son audit kayıtları — "her tool çağrısı iz bırakır" iddiasının kanıtı. */
  auditTrail: procedure.query(async ({ ctx }) => {
    const entries = await ctx.recentAudit(25);
    return entries.map((e) => ({
      at: e.at,
      toolName: e.toolName,
      outcome: e.outcome,
      roles: e.roles,
      durationMs: e.durationMs,
      errorCode: e.errorCode ?? null,
    }));
  }),

  /**
   * Kullanıcının konuşmaları.
   *
   * Depo baştan beri vardı ama arayüzü yoktu: kullanıcı dünkü konuşmasına
   * dönemiyordu. Sohbet tabanlı bir üründe geçmişe erişememek, defterini
   * her akşam çöpe atmak gibidir.
   */
  conversations: procedure.query(async ({ ctx }) => {
    const rows = await ctx.conversations.list(ctx.principal.userId, 30);
    return rows.map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt }));
  }),

  /** Bir konuşmanın turları. Sahiplik depo katmanında doğrulanır. */
  conversation: procedure
    .input(z.object({ id: z.string().min(1).max(64) }))
    .query(async ({ ctx, input }) => {
      const turns = await ctx.conversations.history(input.id, ctx.principal.userId);
      // Sahibi değilse null döner; "bulunamadı" ile "yetkiniz yok" ayrımı
      // yapılmaz — kimliği bilen birine varlığını doğrulamak da bilgidir.
      if (turns === null) throw new TRPCError({ code: "NOT_FOUND" });
      return turns.map((t) => ({ question: t.question, answer: t.answer }));
    }),

  /** Konuşmayı siler. Sahiplik silme sorgusunun içinde doğrulanır. */
  deleteConversation: procedure
    .input(z.object({ id: z.string().min(1).max(64) }))
    .mutation(async ({ ctx, input }) => {
      const removed = await ctx.conversations.remove(input.id, ctx.principal.userId);
      if (!removed) throw new TRPCError({ code: "NOT_FOUND" });
      return { ok: true };
    }),

  // ─────────────── Kullanıcı yönetimi ───────────────
  //
  // Her işlem üç kapıdan geçer: yetki (`admin:user.manage`, yalnızca
  // patronda), kiracı sınırı (hedef kullanıcının BU tenant'ta üyeliği
  // olmalı) ve kendi ayağına sıkma koruması.

  adminUsers: procedure.query(async ({ ctx }) => {
    return admin.listUsers(ctx.principal, ctx.tenant.tenantId);
  }),

  adminRoles: procedure.query(({ ctx }) => {
    // Rol listesi yetkisizden de saklanır: hangi rollerin var olduğu,
    // sistemin yetki haritası hakkında bilgi verir.
    if (!holds(ctx.principal, "admin:user.manage")) return [];
    return admin.ASSIGNABLE_ROLES.map((id) => ({ id, label: ROLE_LABEL[id] }));
  }),

  adminCreateUser: procedure
    .input(
      z.object({
        email: z.string().email().max(320),
        displayName: z.string().min(2).max(120),
        roles: z.array(z.string().min(2).max(40)).min(1).max(7),
      }),
    )
    .mutation(async ({ ctx, input }) => adminCall(() => admin.createUser(ctx.principal, ctx.tenant.tenantId, input))),

  adminSetRoles: procedure
    .input(z.object({ userId: z.string().uuid(), roles: z.array(z.string()).min(1).max(7) }))
    .mutation(async ({ ctx, input }) => {
      await adminCall(() => admin.setRoles(ctx.principal, ctx.tenant.tenantId, input));
      return { ok: true };
    }),

  adminSetActive: procedure
    .input(z.object({ userId: z.string().uuid(), active: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await adminCall(() => admin.setActive(ctx.principal, ctx.tenant.tenantId, input));
      return { ok: true };
    }),

  adminIssueReset: procedure
    .input(z.object({ userId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) =>
      adminCall(() => admin.issueReset(ctx.principal, ctx.tenant.tenantId, input.userId)),
    ),

  adminRevokeSessions: procedure
    .input(z.object({ userId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) =>
      adminCall(() => admin.revokeSessions(ctx.principal, ctx.tenant.tenantId, input.userId)),
    ),

  adminEnableTotp: procedure
    .input(z.object({ userId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) =>
      adminCall(() => admin.enableTwoFactor(ctx.principal, ctx.tenant.tenantId, input.userId)),
    ),

  adminDisableTotp: procedure
    .input(z.object({ userId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      await adminCall(() => admin.disableTwoFactor(ctx.principal, ctx.tenant.tenantId, input.userId));
      return { ok: true };
    }),

  /** Golden question seti — arayüzde deneme soruları olarak da kullanılır. */
  goldenQuestions: procedure.query(() =>
    GOLDEN_QUESTIONS.map((q) => ({ id: q.id, question: q.question, askedBy: q.askedBy })),
  ),
});

export type AppRouter = typeof appRouter;
