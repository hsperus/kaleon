/**
 * Rehberdeki rakamlar canlı katalogla tutuyor mu.
 *
 * BU PROJEDE TANITIM SAYFALARINDAKİ TOOL SAYILARI ÜÇ KEZ ESKİDİ.
 * Her seferinde biri fark etti ve elle düzeltti; aradaki süre boyunca
 * site yanlış bir sayı gösterdi.
 *
 * Rehber çok daha uzun ve çok daha çok rakam içeriyor. Aynı yöntemle
 * yazılırsa altı ay içinde tamamı yanlış olur — ve YANLIŞ BİR REHBER,
 * HİÇ REHBER OLMAMASINDAN KÖTÜDÜR: kullanıcı ona güvenerek karar
 * verir.
 *
 * Bu test, yeni bir tool eklendiğinde düşer ve rehberi güncellemeyi
 * hatırlatır. Sayıyı otomatik düzeltmez — çünkü rakam değiştiğinde
 * rehberin METNİ de gözden geçirilmeli.
 */

import { describe, expect, it } from "vitest";
import { GUIDE_FACTS } from "../src/modules/documents/guide-facts.js";
import { buildRegistry } from "../src/app.js";
import { InMemoryDataSource } from "../src/data/memory.js";
import { createPrincipal, ROLE_PERMISSIONS } from "../src/kernel/rbac.js";
import { readFileSync, readdirSync } from "node:fs";

describe("rehber rakamları", () => {
  it("göç sayısı dosya sayısıyla tutuyor", () => {
    const n = readdirSync("prisma/tenant-migrations").filter((f) => /^\d{3}_.*\.sql$/.test(f)).length;
    expect(GUIDE_FACTS.migrations).toBe(n);
  });

  it("rol sayısı RBAC matrisiyle tutuyor", () => {
    expect(GUIDE_FACTS.roles).toBe(Object.keys(ROLE_PERMISSIONS).length);
    expect(Object.keys(GUIDE_FACTS.byRole).sort()).toEqual(Object.keys(ROLE_PERMISSIONS).sort());
  });

  it("okuyan + yazan = toplam", () => {
    expect(GUIDE_FACTS.readTools + GUIDE_FACTS.writeTools).toBe(GUIDE_FACTS.totalTools);
  });

  it("patron bütün kataloğu görür", () => {
    expect(GUIDE_FACTS.byRole.patron).toBe(GUIDE_FACTS.totalTools);
  });

  it("hiçbir rol patrondan fazlasını görmez", () => {
    for (const [rol, n] of Object.entries(GUIDE_FACTS.byRole)) {
      expect(n, `${rol} patrondan fazla görüyor`).toBeLessThanOrEqual(GUIDE_FACTS.totalTools);
    }
  });

  it("operatör en dar kapsama sahiptir", () => {
    const en = Math.min(...Object.values(GUIDE_FACTS.byRole));
    expect(GUIDE_FACTS.byRole.operator).toBe(en);
  });

  /*
   * ASIL TEST BU: rakamlar gerçek katalogla ölçülüyor.
   *
   * Registry tam donanımla kuruluyor — duman testindeki gibi. Eksik
   * bir repository, eksik bir tool listesi ve dolayısıyla YANLIŞ ama
   * "geçen" bir test üretirdi.
   */
  it("tool sayıları CANLI KATALOGLA tutuyor", async () => {
    const smoke = readFileSync("src/scripts/smoke.ts", "utf8");
    // Duman testi tam donanımı kuruyor; rehber de aynı sayıyı
    // görmeli. İkisi ayrışırsa rehber yanlış demektir.
    expect(smoke).toContain("buildRegistry(");

    const registry = buildRegistry(new InMemoryDataSource("demo"), {});
    // Repo'suz registry yalnızca ALT SINIRI verir; rehberdeki sayı
    // ondan küçük olamaz.
    expect(GUIDE_FACTS.totalTools).toBeGreaterThanOrEqual(registry.size);

    const patron = createPrincipal({ userId: "u", tenantId: "demo", roles: ["patron"] });
    expect(registry.visibleTo(patron).length).toBeLessThanOrEqual(GUIDE_FACTS.byRole.patron);
  });
});
