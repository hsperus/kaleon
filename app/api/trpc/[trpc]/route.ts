import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "../../../../src/server/router.js";
import { createContext } from "../../../../src/server/context.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function handler(req: Request) {
  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req,
    router: appRouter,
    createContext: () => createContext(req),
  });
}

export { handler as GET, handler as POST };
