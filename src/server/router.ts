/**
 * KAELON API yüzeyi.
 *
 * Dikkat: burada iş kuralı YOKTUR. Her uç nokta ya `invokeTool` ya
 * `runConversation` çağırır; ikisi de yetki, doğrulama ve audit'ten geçer.
 * API katmanına iş kuralı sızarsa, UI ve AI farklı davranmaya başlar.
 */

import { z } from "zod";
import { procedure, router } from "./trpc.js";
import { runConversation } from "../ai/runner.js";
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
        },
      );
      return result;
    }),

  /**
   * Boss Mode brifingi.
   *
   * Ekranın doluluğu buradan gelir — sabit metin değil, eşik hesabı.
   * Nöbetçiler kullanıcının kendi yetkisiyle koşar; rol değişince hem
   * koşan nöbetçiler hem çıkan sinyaller değişir.
   */
  briefing: procedure.query(async ({ ctx }) => {
    const b = await buildBriefing(
      { registry: ctx.registry, audit: ctx.audit },
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
      skipped: b.skippedByPermission,
    };
  }),

  /** Son audit kayıtları — "her tool çağrısı iz bırakır" iddiasının kanıtı. */
  auditTrail: procedure.query(({ ctx }) =>
    ctx.auditSink.entries
      .slice(-25)
      .reverse()
      .map((e) => ({
        at: e.at,
        toolName: e.toolName,
        outcome: e.outcome,
        roles: e.roles,
        durationMs: e.durationMs,
        errorCode: e.errorCode ?? null,
      })),
  ),

  /** Golden question seti — arayüzde deneme soruları olarak da kullanılır. */
  goldenQuestions: procedure.query(() =>
    GOLDEN_QUESTIONS.map((q) => ({ id: q.id, question: q.question, askedBy: q.askedBy })),
  ),
});

export type AppRouter = typeof appRouter;
