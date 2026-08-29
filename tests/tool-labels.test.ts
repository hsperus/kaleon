/**
 * Tool adlarının insan karşılıkları.
 *
 * Buradaki asıl test kapsam testidir: kayıtlı HER tool'un bir karşılığı
 * olmalı. Olmazsa kullanıcı ekranda `commit_partner_import · 8 ms` görür.
 * Bu liste elle tutuluyor ve elle tutulan listeler unutulur — test onu
 * unutulmaz kılar.
 */

import { describe, expect, it } from "vitest";
import { TOOL_LABELS, formatDuration, hasToolLabel, toolLabel } from "../src/ai/tool-labels.js";
import { buildRegistry } from "../src/app.js";
import { InMemoryDataSource } from "../src/data/memory.js";
import { createPrincipal } from "../src/kernel/rbac.js";

describe("tool karşılıkları", () => {
  it("KAYITLI HER TOOL'UN İNSAN KARŞILIĞI VAR", () => {
    const registry = buildRegistry(new InMemoryDataSource("t"));
    // Patron tüm tool'ları görür; kapsam kontrolü tam liste üzerinden.
    const all = registry.catalogFor(
      createPrincipal({ userId: "u", tenantId: "t", roles: ["patron"] }),
    ).names;
    const missing = all.filter((n) => !hasToolLabel(n));
    expect(missing, `karşılığı olmayan tool: ${missing.join(", ")}`).toEqual([]);
  });

  it("karşılığı olmayan ad HAM HÂLİYLE gösterilir", () => {
    // Boş bırakmak veya "işlem yapıldı" demek, yeni tool'u görünmez kılardı.
    expect(toolLabel("bilinmeyen_tool")).toBe("bilinmeyen_tool");
  });

  it("bilinen ad çevrilir", () => {
    expect(toolLabel("get_bank_balance")).toBe("Banka bakiyesi okundu");
  });

  it("karşılıklar Türkçe ve fiil kipi tutarlı", () => {
    for (const [name, label] of Object.entries(TOOL_LABELS)) {
      expect(label.length, name).toBeGreaterThan(3);
      // Ham tool adı sızmamalı.
      expect(label, name).not.toContain("_");
      // Cümle büyük harfle başlar.
      expect(label[0], name).toBe(label[0]!.toLocaleUpperCase("tr"));
    }
  });
});

describe("süre biçimi", () => {
  it("milisaniye boşlukla yazılır", () => {
    // "8ms" teknik çıktı gibi okunur.
    expect(formatDuration(8)).toBe("8 ms");
    expect(formatDuration(999)).toBe("999 ms");
  });

  it("SANİYEYİ AŞAN SÜRE MİLİSANİYE OLARAK YAZILMAZ", () => {
    // "4200 ms" kimsenin kafasında bir şeye karşılık gelmez.
    expect(formatDuration(4200)).toBe("4,2 sn");
    expect(formatDuration(1000)).toBe("1 sn");
  });

  it("sıfır süre çökertmez", () => {
    expect(formatDuration(0)).toBe("0 ms");
  });
});
