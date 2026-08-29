/** Geçerli kimlik. Arayüz açılışta bunu sorar. */

import { createContext, ROLE_LABEL, UnauthenticatedError } from "../../../../src/server/context.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  try {
    const ctx = await createContext(req);
    return Response.json({
      userId: ctx.principal.userId,
      tenantId: ctx.principal.tenantId,
      roles: ctx.principal.roles,
      roleLabel: ROLE_LABEL[ctx.principal.roles[0]!],
      maxAuthority: ctx.principal.maxAuthority,
      identitySource: ctx.identitySource,
      dataPlane: ctx.dataPlane,
      toolCount: ctx.registry.catalogFor(ctx.principal).names.length,
    });
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return Response.json({ error: "unauthenticated" }, { status: 401 });
    }
    throw e;
  }
}
