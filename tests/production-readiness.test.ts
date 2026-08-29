/**
 * Üretime hazırlık kontrolleri.
 *
 * Buradaki testler iş mantığı sınamaz; YANLIŞ AYARLA AÇILMAYI sınar.
 * Yarı çalışan bir sunucu, çalışmayan bir sunucudan tehlikelidir: sağlık
 * kontrolünü geçer, trafik alır ve isteklerin bir kısmını sessizce bozar.
 */

import { describe, expect, it, vi } from "vitest";
import { checkEnv, assertEnv } from "../src/server/env.js";

const OK_ENV = {
  SHARED_DATABASE_URL: "postgresql://u@localhost:5432/kaelon?schema=shared",
  TENANT_DATABASE_URL: "postgresql://u@localhost:5432/kaelon?schema=tenant_template",
  ANTHROPIC_API_KEY: "sk-ant-test",
};

describe("ortam doğrulaması", () => {
  it("tam ayarla üretim geçer", () => {
    const r = checkEnv({ ...OK_ENV, NODE_ENV: "production" });
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it("ÜRETİMDE eksik veritabanı ayarı HATA", () => {
    const r = checkEnv({ ...OK_ENV, SHARED_DATABASE_URL: undefined, NODE_ENV: "production" });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toContain("SHARED_DATABASE_URL");
  });

  it("geliştirmede aynı eksiklik yalnızca UYARI", () => {
    // Her deneme için tam bir ortam kurmaya zorlamak, hiç denememeye yol açar.
    const r = checkEnv({ ...OK_ENV, SHARED_DATABASE_URL: undefined, NODE_ENV: "development" });
    expect(r.ok).toBe(true);
    expect(r.warnings.join(" ")).toContain("SHARED_DATABASE_URL");
  });

  it("ÜRETİMDE API ANAHTARI YOKSA AÇILMAZ — sessiz demo moduna düşmez", () => {
    // Sessiz düşüş, açık bir çökmeden çok daha pahalıdır: müşteri uydurma
    // verileri gerçek sanır.
    const r = checkEnv({ ...OK_ENV, ANTHROPIC_API_KEY: undefined, NODE_ENV: "production" });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toContain("ANTHROPIC_API_KEY");
  });

  it("bozuk bağlantı dizesi HER ORTAMDA hata", () => {
    // Yanlış yazılmış bir URL geliştirmede de çalışmaz; uyarıp geçmek
    // saatlerce yanlış yerde hata aramak demektir.
    for (const bad of ["saçma", "mysql://h/db", "postgresql://", "postgresql://h"]) {
      const r = checkEnv({ ...OK_ENV, SHARED_DATABASE_URL: bad, NODE_ENV: "development" });
      expect(r.ok, bad).toBe(false);
    }
  });

  it("kontrol düzlemi ile tenant aynı bağlantıysa uyarır", () => {
    const same = "postgresql://u@localhost:5432/kaelon";
    const r = checkEnv({
      ...OK_ENV,
      SHARED_DATABASE_URL: same,
      TENANT_DATABASE_URL: same,
      NODE_ENV: "production",
    });
    expect(r.warnings.join(" ")).toContain("aynı");
  });

  it("assertEnv üretimde hata varsa FIRLATIR", () => {
    const log = { warn: vi.fn(), error: vi.fn() } as unknown as Console;
    expect(() =>
      assertEnv({ ...OK_ENV, SHARED_DATABASE_URL: undefined, NODE_ENV: "production" }, log),
    ).toThrow(/başlatılamadı/);
  });

  it("assertEnv sorun yoksa sessizce geçer", () => {
    const log = { warn: vi.fn(), error: vi.fn() } as unknown as Console;
    const r = assertEnv({ ...OK_ENV, NODE_ENV: "production" }, log);
    expect(r.ok).toBe(true);
    expect(log.error).not.toHaveBeenCalled();
  });

  it("uyarılar loglanır ama açılışı engellemez", () => {
    const log = { warn: vi.fn(), error: vi.fn() } as unknown as Console;
    assertEnv({ ...OK_ENV, ANTHROPIC_API_KEY: undefined, NODE_ENV: "development" }, log);
    expect(log.warn).toHaveBeenCalled();
  });
});

describe("demo modu — kaza ile karar arasındaki fark", () => {
  const noKey = { ...OK_ENV, ANTHROPIC_API_KEY: undefined, NODE_ENV: "production" };

  it("üretimde anahtarsız açılış varsayılan olarak REDDEDİLİR", () => {
    expect(checkEnv(noKey).ok).toBe(false);
  });

  it("AÇIK İZİNLE demo modu üretimde de kabul edilir", () => {
    // Sessizce düşmek değil; operatörün bilerek seçmesi.
    const r = checkEnv({ ...noKey, KAELON_ALLOW_DEMO_MODE: "1" });
    expect(r.ok).toBe(true);
    expect(r.warnings.join(" ")).toContain("DEMO MODU");
  });

  it("izin bayrağı yalnızca tam olarak '1' ile açılır", () => {
    // "true", "yes", "0" gibi değerler kazara açılmayı davet eder.
    for (const v of ["true", "yes", "0", "", "evet"]) {
      expect(checkEnv({ ...noKey, KAELON_ALLOW_DEMO_MODE: v }).ok, v).toBe(false);
    }
  });

  it("anahtar varken bayrak kalmışsa uyarır", () => {
    const r = checkEnv({ ...OK_ENV, NODE_ENV: "production", KAELON_ALLOW_DEMO_MODE: "1" });
    expect(r.ok).toBe(true);
    expect(r.warnings.join(" ")).toContain("gereksiz");
  });
});
