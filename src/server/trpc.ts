/**
 * tRPC kurulumu. Mimari v1 §5.1: frontend ↔ backend iletişimi tRPC ile,
 * dış sistemler REST ile. Uçtan uca tip güvenliği bu katmanda kazanılır.
 */

import { initTRPC } from "@trpc/server";
import superjson from "superjson";
import type { RequestContext } from "./context.js";

const t = initTRPC.context<RequestContext>().create({ transformer: superjson });

export const router = t.router;
export const procedure = t.procedure;
