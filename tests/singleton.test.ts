/**
 * Süreç geneli tekil değerler.
 *
 * Bu dosyanın varlık sebebi somut bir hatadır: Next.js her route'u ayrı
 * paketler ve aynı dosyanın modül değişkeni iki ayrı kopya olabilir. Kod
 * okununca durum paylaşılıyormuş gibi görünür; çalışırken görünmez.
 * `/api/ask` içinde oluşan onay bekleyen işlem, `/api/trpc` içinde
 * "bulunamadı" olurdu ve hiçbir hata mesajı sebebini söylemezdi.
 */

import { describe, expect, it } from "vitest";
import { box, singleton } from "../src/server/singleton.js";

describe("tekil değerler", () => {
  it("aynı anahtar aynı örneği döndürür", () => {
    const a = singleton("t.map", () => new Map<string, number>());
    const b = singleton("t.map", () => new Map<string, number>());
    a.set("x", 1);
    expect(b.get("x")).toBe(1);
    expect(a).toBe(b);
  });

  it("KURUCU YALNIZCA BİR KEZ ÇALIŞIR", () => {
    let calls = 0;
    const make = () => {
      calls += 1;
      return { n: calls };
    };
    singleton("t.once", make);
    singleton("t.once", make);
    expect(calls).toBe(1);
  });

  it("farklı anahtarlar karışmaz", () => {
    expect(singleton("t.a", () => 1)).toBe(1);
    expect(singleton("t.b", () => 2)).toBe(2);
  });

  it("kutu ayrı yerlerden okunup yazılabilir", () => {
    const writer = box<string | null>("t.box", null);
    const reader = box<string | null>("t.box", null);
    writer.set("hata");
    expect(reader.get()).toBe("hata");
  });

  it("KUTUNUN BAŞLANGIÇ DEĞERİ İKİNCİ ÇAĞRIDA EZMEZ", () => {
    // Ezseydi, ikinci route'un modülü yüklendiği anda birincinin yazdığı
    // durum sessizce sıfırlanırdı — hatanın en sinsi hâli.
    const first = box<number>("t.box2", 0);
    first.set(42);
    const second = box<number>("t.box2", 0);
    expect(second.get()).toBe(42);
  });

  it("globalThis üzerinde durur — modül kopyaları aynı yeri görür", () => {
    singleton("t.global", () => "değer");
    const slot = (globalThis as unknown as Record<symbol, { values: Map<string, unknown> }>)[
      Symbol.for("kaelon.singletons")
    ];
    expect(slot?.values.get("t.global")).toBe("değer");
  });
});
