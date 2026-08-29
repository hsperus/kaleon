/**
 * Akış uç noktası — ajan döngüsünün ilerleme olaylarını NDJSON olarak yayar.
 *
 * Neden tRPC değil: tRPC mutation'ı tek bir cevap döndürür. Burada istenen
 * şey, döngü ilerlerken olayları AKITMAK. Basit bir NDJSON akışı hem daha az
 * bağımlılık hem de tarayıcı tarafında doğrudan okunabilir bir sözleşme.
 * Tip güvenliği `RunEvent` birleşim tipiyle korunuyor.
 *
 * KONUŞMA SÜREKLİLİĞİ: `conversationId` verilirse önceki turlar modele
 * taşınır; verilmezse yeni bir konuşma açılır ve kimliği ilk olayda döner.
 * Sahiplik her istekte doğrulanır — başkasının konuşmasına yazılamaz.
 *
 * İPTAL: tarayıcı bağlantıyı kapattığında `request.signal` düşer ve döngü
 * durur. Olmasaydı, kullanıcı sekmeyi kapattıktan sonra da model turları
 * çalışmaya ve para harcamaya devam ederdi.
 */

import { z } from "zod";
import { runConversation, type RunEvent } from "../../../src/ai/runner.js";
import { createContext, ROLE_LABEL, UnauthenticatedError } from "../../../src/server/context.js";
import { recentTurns, titleFrom } from "../../../src/modules/conversation/repository.js";
import { askThrottle } from "../../../src/server/throttle.js";
import { log } from "../../../src/server/log.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  question: z.string().min(2).max(2000),
  conversationId: z.string().uuid().or(z.string().regex(/^conv-\d+$/)).optional(),
  /** Sohbete eklenmiş dosya. İçeriği değil, KİMLİĞİ taşınır. */
  uploadId: z.string().uuid().optional(),
});

export async function POST(req: Request): Promise<Response> {
  let ctx;
  try {
    ctx = await createContext(req);
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return Response.json({ error: "unauthenticated" }, { status: 401 });
    }
    throw e;
  }

  // Model çağrısı para harcar; sınırsız istek hem maliyet hem yük sorunudur.
  const gate = askThrottle.check(`${ctx.principal.tenantId}:${ctx.principal.userId}`);
  if (!gate.allowed) {
    return Response.json(
      { error: "Çok fazla istek gönderildi. Lütfen biraz bekleyin." },
      { status: 429, headers: { "Retry-After": String(Math.ceil(gate.retryAfterMs / 1000)) } },
    );
  }

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "Geçersiz istek" }, { status: 400 });
  }

  const { question } = parsed.data;

  /**
   * Eklenen dosya modele CÜMLE olarak bildirilir, içerik olarak değil.
   *
   * Model dosyanın var olduğunu ve kimliğini bilmeli ki doğru tool'u doğru
   * parametreyle çağırsın. İçeriği görmesine gerek yok: ayrıştırma ve
   * doğrulama deterministik kodda yapılıyor ve dört bin satırı modele
   * göndermek hem pahalı hem faydasız.
   */
  const questionWithFile = parsed.data.uploadId
    ? `${question}\n\n[Kullanıcı bir dosya ekledi. uploadId: ${parsed.data.uploadId}]`
    : question;

  // ── Konuşma: var olanı doğrula veya yenisini aç
  let conversationId = parsed.data.conversationId ?? null;
  let history: readonly { question: string; answer: string }[] = [];

  if (conversationId) {
    const existing = await ctx.conversations.history(conversationId, ctx.principal.userId);
    // Sahibi değilse "bulunamadı" denmez, yeni konuşma da açılmaz: istemciye
    // sessizce başka bir konuşmaya yazdırmak, veri karışması demektir.
    if (existing === null) {
      return Response.json({ error: "Konuşma bulunamadı." }, { status: 404 });
    }
    history = recentTurns(existing);
  } else {
    conversationId = await ctx.conversations.create(ctx.principal.userId, titleFrom(question));
  }

  const encoder = new TextEncoder();
  const activeConversationId = conversationId;
  const correlationId = crypto.randomUUID();
  const startedAt = Date.now();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (
        event: RunEvent | { type: "error"; message: string } | { type: "conversation"; id: string },
      ) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
        } catch {
          // İstemci gitti; yazmayı bırak ama döngüyü sinyal durduracak.
          closed = true;
        }
      };

      // İstemci hangi konuşmaya yazdığını İLK olayda öğrenir; akış yarıda
      // kesilse bile devam edebilmesi için gereklidir.
      send({ type: "conversation", id: activeConversationId });

      try {
        const result = await runConversation(
          { gateway: ctx.completer, registry: ctx.registry, audit: ctx.audit },
          {
            question: questionWithFile,
            principal: ctx.principal,
            tenant: ctx.tenant,
            correlationId,
            channel: ctx.channel,
            task: "lookup",
            display: {
              name: ctx.displayName,
              roleLabel: ROLE_LABEL[ctx.principal.roles[0]!],
              companyName: ctx.companyName,
            },
            history,
            signal: req.signal,
            onEvent: send,
          },
        );

        log.info("soru tamamlandı", {
          correlationId,
          tenantId: ctx.principal.tenantId,
          userId: ctx.principal.userId,
          route: "/api/ask",
          durationMs: Date.now() - startedAt,
          toolCount: result.toolCalls.length,
          stopReason: result.stopReason,
          costUsd: result.costUsd,
        });

        // Turu ancak GERÇEKTEN cevap üretildiyse kaydet. Boş veya iptal
        // edilmiş bir turu geçmişe yazmak, sonraki soruları bozar.
        if (result.answer.trim() && result.stopReason !== "aborted") {
          await ctx.conversations
            .appendTurn(activeConversationId, { question, answer: result.answer })
            .catch(() => undefined);
        }
      } catch (e) {
        // Kullanıcıya teknik ayrıntı değil, logdaki satırı bulmaya yarayan
        // bir referans gider.
        const ref = log.fail("soru işlenemedi", e, {
          correlationId,
          tenantId: ctx.principal.tenantId,
          userId: ctx.principal.userId,
          route: "/api/ask",
          durationMs: Date.now() - startedAt,
        });
        send({
          type: "error",
          message: `İstek tamamlanamadı. Destek kodu: ${ref}`,
        });
      } finally {
        closed = true;
        try {
          controller.close();
        } catch {
          // Zaten kapanmış.
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
}
