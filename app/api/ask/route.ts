/**
 * Akış uç noktası — ajan döngüsünün ilerleme olaylarını NDJSON olarak yayar.
 *
 * Neden tRPC değil: tRPC mutation'ı tek bir cevap döndürür. Burada istenen
 * şey, döngü ilerlerken olayları AKITMAK. Basit bir NDJSON akışı hem daha az
 * bağımlılık hem de tarayıcı tarafında doğrudan okunabilir bir sözleşme.
 * Tip güvenliği `RunEvent` birleşim tipiyle korunuyor.
 */

import { z } from "zod";
import { runConversation, type RunEvent } from "../../../src/ai/runner.js";
import { createContext, ROLE_LABEL, UnauthenticatedError } from "../../../src/server/context.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({ question: z.string().min(2).max(2000) });

export async function POST(req: Request): Promise<Response> {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "Geçersiz istek" }, { status: 400 });
  }

  let ctx;
  try {
    ctx = await createContext(req);
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return Response.json({ error: "unauthenticated" }, { status: 401 });
    }
    throw e;
  }
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: RunEvent | { type: "error"; message: string }) => {
        controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      };

      try {
        await runConversation(
          { gateway: ctx.completer, registry: ctx.registry, audit: ctx.audit },
          {
            question: parsed.data.question,
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
            onEvent: send,
          },
        );
      } catch (e) {
        send({ type: "error", message: (e as Error).message });
      } finally {
        controller.close();
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
