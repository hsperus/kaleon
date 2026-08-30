/**
 * Tool şemalarının sağlayıcı kısıtlarına toplu uyumu.
 *
 * BU HATA SINIFI İKİ KEZ ÜRETİMDE ORTAYA ÇIKTI. Önce `exclusiveMinimum`,
 * sonra `minItems: 2`. İkisinde de sonuç aynıydı: sağlayıcı tek bir
 * tool'un şemasını reddetti ve İSTEĞİN TAMAMI düştü — yani bir tool
 * yüzünden 118 tool birden kullanılamaz hâle geldi. Kullanıcı bunu
 * "sistem bozuk" olarak gördü.
 *
 * Birim testleri yakalayamamıştı çünkü her test kendi küçük tool'unu
 * kuruyordu; kimse REGISTRY'NİN TAMAMINA bakmıyordu. Bu dosya tam da
 * onu yapar: yeni bir tool eklendiğinde ya da bir şema değiştiğinde,
 * hata gerçek modele gitmeden önce burada çıkar.
 */

import { describe, expect, it } from "vitest";
import { buildRegistry } from "../src/app.js";
import { InMemoryDataSource } from "../src/data/memory.js";

/**
 * Her özelliğe cevap veren sahte depo.
 *
 * Şema kurulumu depoya DOKUNMAZ — depo yalnızca `execute` içinde
 * çağrılır. Bu yüzden tool'ları kaydetmek için gerçek bir veritabanı
 * gerekmiyor ve bu test veritabanı olmayan ortamlarda da çalışıyor.
 */
function stub(): unknown {
  return new Proxy(function () {} as unknown as object, {
    get: () => stub(),
    apply: () => stub(),
  });
}

function fullRegistry() {
  const repos = new Proxy({} as Record<string, unknown>, {
    get: () => stub(),
    has: () => true,
  });
  return buildRegistry(new InMemoryDataSource("t"), repos as never);
}

/**
 * Sağlayıcının KABUL ETTİĞİ şema anahtarları.
 *
 * İZİN LİSTESİ, YASAK LİSTESİ DEĞİL — VE BU BİLİNÇLİ. Üç kez aynı
 * sınıftan hata çıktı (`exclusiveMinimum`, `minItems: 2`,
 * `propertyNames`) ve her seferinde yasak listesine bir madde eklendi.
 * Yasak listesi yalnızca BİLDİĞİMİZ hataları yakalar; bir dahaki zod
 * yapısı yine üretime kadar gider. İzin listesi tersini yapar: yeni ve
 * tanınmayan her anahtar burada düşer.
 *
 * Yeni bir anahtar gerçekten destekleniyorsa listeye eklenir — ama bu
 * bilinçli bir karar olur, sessiz bir kaza değil.
 */
const ALLOWED_KEYS = new Set([
  "type", "properties", "required", "items", "description", "enum",
  "additionalProperties", "anyOf", "oneOf", "allOf", "const", "format",
  "default", "title", "$ref", "$defs", "definitions", "nullable",
  "minItems", "maxItems", "minLength", "maxLength", "pattern",
]);

const NUMERIC_BANNED = [
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
];

interface Finding {
  readonly tool: string;
  readonly path: string;
  readonly problem: string;
}

/**
 * Şemayı gezer.
 *
 * `properties`, `$defs` ve `definitions` altındaki anahtarlar ALAN
 * ADIDIR, şema anahtarı değil — orada izin listesi uygulanmaz. İlk
 * sürüm bunu ayırmıyordu ve her alan adını "tanınmayan anahtar" diye
 * bildiriyordu; kullanılamaz bir test, hiç test olmamasından kötüdür
 * çünkü gürültüsü gerçek bulguyu gömer.
 */
const NAME_MAPS = new Set(["properties", "$defs", "definitions"]);

function scan(node: unknown, path: string, tool: string, out: Finding[]): void {
  if (Array.isArray(node)) {
    node.forEach((n, i) => scan(n, `${path}[${i}]`, tool, out));
    return;
  }
  if (node === null || typeof node !== "object") return;
  const o = node as Record<string, unknown>;

  const isNumeric = o["type"] === "integer" || o["type"] === "number";
  const isArray = o["type"] === "array";

  for (const [k, v] of Object.entries(o)) {
    if (isNumeric && NUMERIC_BANNED.includes(k)) {
      out.push({ tool, path: `${path}.${k}`, problem: `sayısal aralık anahtarı (${k})` });
    }
    // Sağlayıcı yalnızca 0 ve 1 kabul ediyor.
    if (isArray && k === "minItems" && typeof v === "number" && v !== 0 && v !== 1) {
      out.push({ tool, path: `${path}.minItems`, problem: `minItems=${v}` });
    }
    if (!ALLOWED_KEYS.has(k)) {
      out.push({ tool, path: `${path}.${k}`, problem: `tanınmayan şema anahtarı (${k})` });
    }

    if (NAME_MAPS.has(k) && v && typeof v === "object" && !Array.isArray(v)) {
      // Alan adları serbesttir; yalnızca DEĞERLERİ gezilir.
      for (const [name, sub] of Object.entries(v as Record<string, unknown>)) {
        scan(sub, `${path}.${k}.${name}`, tool, out);
      }
      continue;
    }

    scan(v, `${path}.${k}`, tool, out);
  }
}

describe("registry'deki HER tool şeması sağlayıcıya uygun", () => {
  const registry = fullRegistry();
  const tools = registry.all();

  it("registry gerçekten dolu — test boşa çalışmıyor", () => {
    // Sahte depolar bir gün tool kaydını engellerse bu test sessizce
    // "hiç sorun yok" derdi; eşik onu yakalar.
    expect(tools.length).toBeGreaterThan(100);
  });

  it("DESTEKLENMEYEN ŞEMA ANAHTARI YOK", () => {
    const findings: Finding[] = [];
    for (const t of tools) {
      scan(t.schema.input_schema, t.name, t.name, findings);
    }
    // Hata mesajı hangi tool ve hangi alan olduğunu söylesin: "bir yerde
    // sorun var" diyen bir test, düzeltmesi en pahalı testtir.
    expect(
      findings.map((f) => `${f.path} → ${f.problem}`),
      `Sağlayıcının reddedeceği şema anahtarları:\n${findings
        .map((f) => `  ${f.path}: ${f.problem}`)
        .join("\n")}`,
    ).toEqual([]);
  });

  it("her tool'un adı ve açıklaması var", () => {
    for (const t of tools) {
      expect(t.name).toMatch(/^[a-z][a-z0-9_]{2,63}$/);
      expect(t.schema.description.length).toBeGreaterThan(20);
    }
  });
});

describe("hata mesajları kullanıcıya ulaşır", () => {
  /**
   * DÜZ `Error` KULLANICIYA ULAŞMAZ.
   *
   * Çekirdek yalnızca `userFacing` işaretli `KaelonError` alt
   * sınıflarının mesajını ekrana taşır; düz `Error` "Tool
   * çalıştırılamadı: <ad>" olarak görünür. Bu, kullanıcının neyi
   * yanlış yaptığını değil sistemin bozuk olduğunu düşünmesine yol
   * açar — nitekim içe aktarma yetki reddi tam olarak böyle
   * görünüyordu ve fark edilmesi bir denetim taraması gerektirdi.
   *
   * Bu test kaynak kodu tarar: tool tanımlarında düz `throw new
   * Error(` kalmamalıdır.
   */
  it("TOOL TANIMLARINDA DÜZ Error KALMADI", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");

    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((f) => {
        const p = join(dir, f);
        return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
      });

    const offenders: string[] = [];
    for (const file of walk("src/modules")) {
      const src = readFileSync(file, "utf8");
      if (!src.includes("defineTool")) continue;
      const lines = src.split("\n");
      lines.forEach((line, i) => {
        if (/throw new Error\(/.test(line)) offenders.push(`${file}:${i + 1}`);
      });
    }

    expect(
      offenders,
      `Bu satırlarda düz Error var; kullanıcıya görünen bir hata sınıfı kullanın ` +
        `(BusinessRuleError vb.):\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });
});
