import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "../../../../src/server/router.js";
import { TRPCError } from "@trpc/server";
import { createContext, UnauthenticatedError } from "../../../../src/server/context.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function handler(req: Request) {
  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req,
    router: appRouter,
    createContext: async () => {
      try {
        return await createContext(req);
      } catch (e) {
        // Kimliksiz istek 500 değil 401 olmalı: istemci "sunucu bozuldu"
        // ile "giriş yapmalısın" arasındaki farkı görebilmeli.
        if (e instanceof UnauthenticatedError) {
          throw new TRPCError({ code: "UNAUTHORIZED", message: e.message });
        }
        throw e;
      }
    },
  });
}

export { handler as GET, handler as POST };
