/**
 * İstek bağlamı — kimlik yollarının doğrulanması.
 *
 * BURADAKİ ASIL TEST ÜRETİM DAVRANIŞIDIR:
 * `x-kaelon-dev-role` başlığı geliştirmede rol değiştirmeye yarar. Bu
 * kolaylık üretime sızarsa, kimliği olmayan bir istek kendini patron ilan
 * edebilir. Aşağıdaki test tam olarak bunu sınar ve koruma kaldırılırsa
 * KIRILIR (BUILD-PLAN değişmez #8).
 */

import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

function reqWithRole(role: string): Request {
  return new Request("http://localhost/api/ask", { headers: { "x-kaelon-dev-role": role } });
}

describe("geliştirme kimliği", () => {
  it("geliştirmede başlıktan rol okunur", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.resetModules();
    const { createContext } = await import("../src/server/context.js");
    const ctx = await createContext(reqWithRole("depo_sorumlusu"));
    expect(ctx.principal.roles).toEqual(["depo_sorumlusu"]);
    expect(ctx.identitySource).toBe("dev-header");
  });

  it("bilinmeyen rol başlığı sessizce kabul edilmez", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.resetModules();
    const { createContext } = await import("../src/server/context.js");
    const ctx = await createContext(reqWithRole("tanri"));
    expect(ctx.principal.roles).toEqual(["patron"]); // geçerli listeye düşer
  });

  it("ÜRETİMDE oturumsuz istek REDDEDİLİR — başlık ne olursa olsun", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.resetModules();
    const { createContext, UnauthenticatedError } = await import("../src/server/context.js");
    await expect(createContext(reqWithRole("patron"))).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it("ÜRETİMDE geçersiz çerez de reddedilir", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.resetModules();
    const { createContext, UnauthenticatedError } = await import("../src/server/context.js");
    const req = new Request("http://localhost/api/ask", {
      headers: { cookie: "kaelon_session=uydurma-token" },
    });
    await expect(createContext(req)).rejects.toBeInstanceOf(UnauthenticatedError);
  });
});

describe("veri düzlemi işareti", () => {
  it("bağlam demo veri kullandığını AÇIKÇA taşır", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.resetModules();
    const { createContext } = await import("../src/server/context.js");
    const ctx = await createContext(reqWithRole("patron"));
    expect(ctx.dataPlane).toBe("demo");
  });
});
