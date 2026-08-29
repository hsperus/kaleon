/**
 * Konuşma sürekliliği.
 *
 * Sohbet tabanlı bir ERP'de "peki ya geçen ay?" cevaplanabilmelidir.
 * Ama süreklilik iki tehlike getirir ve ikisi de burada sınanır:
 * başkasının konuşmasını okumak, ve bayat veriyi taze gibi sunmak.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient as SharedPrisma } from "../src/db/generated/shared/index.js";
import { PrismaClient as TenantPrisma } from "../src/db/generated/tenant/index.js";
import { dropTenantSchema, provisionTenantSchema } from "../src/db/provision.js";
import { urlForSchema } from "../src/db/client.js";
import { PrismaConversationRepository } from "../src/db/conversation-repository.js";
import {
  InMemoryConversationRepository,
  MAX_HISTORY_TURNS,
  recentTurns,
  titleFrom,
  type ConversationRepository,
} from "../src/modules/conversation/repository.js";

const SHARED_URL = process.env["SHARED_DATABASE_URL"];
const TENANT_URL = process.env["TENANT_DATABASE_URL"];
const enabled = Boolean(SHARED_URL && TENANT_URL);
const SCHEMA = "tenant_it_conv";

const U1 = "11111111-1111-1111-1111-111111111111";
const U2 = "22222222-2222-2222-2222-222222222222";

describe("başlık üretimi", () => {
  it("kısa soru olduğu gibi başlık olur", () => {
    expect(titleFrom("Bankada ne kadar param var?")).toBe("Bankada ne kadar param var?");
  });

  it("uzun soru KELİME ORTASINDAN kesilmez", () => {
    const long =
      "Geçen ay Burçelik'ten gelen faturaların hangileri üç yönlü eşleştirmede takıldı acaba";
    const t = titleFrom(long);
    expect(t.length).toBeLessThanOrEqual(62);
    expect(t.endsWith("…")).toBe(true);
    // Kesme noktası boşlukta olmalı; yarım kelime okunmaz bir başlık verir.
    expect(t.slice(0, -1)).toBe(t.slice(0, -1).trimEnd());
    expect(long.startsWith(t.slice(0, -1))).toBe(true);
  });

  it("boş soru başlıksız bırakılmaz", () => {
    expect(titleFrom("   ")).toBe("Yeni konuşma");
  });
});

describe("geçmiş sınırı", () => {
  const turns = Array.from({ length: 30 }, (_, i) => ({
    question: `soru ${i}`,
    answer: `cevap ${i}`,
  }));

  it("GEÇMİŞİN SONU taşınır, başı değil", () => {
    // Yanlış uç alınırsa model en eski turları görür ve az önce konuşulanı
    // bilmez — sürekliliğin tam tersi.
    const kept = recentTurns(turns, 3);
    expect(kept.map((t) => t.question)).toEqual(["soru 27", "soru 28", "soru 29"]);
  });

  it("kısa geçmiş olduğu gibi kalır", () => {
    expect(recentTurns(turns.slice(0, 2), 5)).toHaveLength(2);
  });

  it("varsayılan sınır makul", () => {
    expect(recentTurns(turns)).toHaveLength(MAX_HISTORY_TURNS);
  });
});

/** Aynı sözleşmeyi iki uygulamada da sınar. */
function contractTests(name: string, make: () => Promise<ConversationRepository>) {
  describe(name, () => {
    let repo: ConversationRepository;

    beforeEach(async () => {
      repo = await make();
    });

    it("tur eklenir ve sırayla geri gelir", async () => {
      const id = await repo.create(U1, "Test");
      await repo.appendTurn(id, { question: "Bakiye ne?", answer: "12.400.000 TL." });
      await repo.appendTurn(id, { question: "Peki EUR?", answer: "198.400 EUR." });

      expect(await repo.history(id, U1)).toEqual([
        { question: "Bakiye ne?", answer: "12.400.000 TL." },
        { question: "Peki EUR?", answer: "198.400 EUR." },
      ]);
    });

    it("BAŞKASININ KONUŞMASI OKUNAMAZ — kimliği bilmek yetki değildir", async () => {
      const id = await repo.create(U1, "Gizli");
      await repo.appendTurn(id, { question: "Maaşlar ne kadar?", answer: "Toplam 4.2M TL." });
      expect(await repo.history(id, U2)).toBe(null);
    });

    it("olmayan konuşma null döner", async () => {
      expect(await repo.history("00000000-0000-0000-0000-000000000000", U1)).toBe(null);
    });

    it("kullanıcı yalnızca kendi konuşmalarını listeler", async () => {
      await repo.create(U1, "Benim");
      await repo.create(U2, "Onun");
      const mine = await repo.list(U1);
      expect(mine.map((c) => c.title)).toEqual(["Benim"]);
    });

    it("BAŞKASININ KONUŞMASI SİLİNEMEZ", async () => {
      const id = await repo.create(U1, "Benim");
      expect(await repo.remove(id, U2)).toBe(false);
      expect(await repo.history(id, U1)).not.toBe(null);
    });

    it("sahibi silebilir", async () => {
      const id = await repo.create(U1, "Benim");
      expect(await repo.remove(id, U1)).toBe(true);
      expect(await repo.history(id, U1)).toBe(null);
    });
  });
}

contractTests("Konuşma deposu (bellek)", async () => new InMemoryConversationRepository());

describe.skipIf(!enabled)("Konuşma deposu (Postgres)", () => {
  let shared: SharedPrisma;
  let db: TenantPrisma;
  let repo: PrismaConversationRepository;

  beforeAll(async () => {
    shared = new SharedPrisma();
    await dropTenantSchema(shared, SCHEMA);
    await provisionTenantSchema(shared, SCHEMA);
    db = new TenantPrisma({ datasources: { db: { url: urlForSchema(TENANT_URL!, SCHEMA) } } });
    repo = new PrismaConversationRepository(db);
  }, 60_000);

  afterAll(async () => {
    await db?.$disconnect();
    if (shared) {
      await dropTenantSchema(shared, SCHEMA);
      await shared.$disconnect();
    }
  });

  beforeEach(async () => {
    await db.conversationMessage.deleteMany();
    await db.conversation.deleteMany();
  });

  it("tur eklenir ve sırayla geri gelir", async () => {
    const id = await repo.create(U1, "Test");
    await repo.appendTurn(id, { question: "Bakiye ne?", answer: "12.400.000 TL." });
    await repo.appendTurn(id, { question: "Peki EUR?", answer: "198.400 EUR." });
    expect(await repo.history(id, U1)).toEqual([
      { question: "Bakiye ne?", answer: "12.400.000 TL." },
      { question: "Peki EUR?", answer: "198.400 EUR." },
    ]);
  });

  it("SIRA ZAMANA DEĞİL SAYACA DAYANIR", async () => {
    const id = await repo.create(U1, "Test");
    for (let i = 0; i < 5; i++) {
      await repo.appendTurn(id, { question: `s${i}`, answer: `c${i}` });
    }
    // Zaman damgaları aynı milisaniyede olsa bile sıra bozulmaz.
    const rows = await db.conversationMessage.findMany({ orderBy: { seq: "asc" } });
    expect(rows.map((r) => r.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const hist = await repo.history(id, U1);
    expect(hist!.map((t) => t.question)).toEqual(["s0", "s1", "s2", "s3", "s4"]);
  });

  it("AYNI SIRA İKİ KEZ YAZILAMAZ", async () => {
    const id = await repo.create(U1, "Test");
    await repo.appendTurn(id, { question: "s", answer: "c" });
    await expect(
      db.conversationMessage.create({
        data: { conversationId: id, seq: 0, role: "user", content: "çakışma" },
      }),
    ).rejects.toThrow();
  });

  it("CEVAPSIZ SORU GEÇMİŞE KONMAZ", async () => {
    // Modele yarım bir tur göstermek, kendi cevabını uydurmasına davetiyedir.
    const id = await repo.create(U1, "Test");
    await db.conversationMessage.create({
      data: { conversationId: id, seq: 0, role: "user", content: "cevapsız soru" },
    });
    expect(await repo.history(id, U1)).toEqual([]);
  });

  it("BAŞKASININ KONUŞMASI OKUNAMAZ", async () => {
    const id = await repo.create(U1, "Gizli");
    await repo.appendTurn(id, { question: "Maaşlar?", answer: "4.2M TL." });
    expect(await repo.history(id, U2)).toBe(null);
  });

  it("BAŞKASININ KONUŞMASI SİLİNEMEZ", async () => {
    const id = await repo.create(U1, "Benim");
    expect(await repo.remove(id, U2)).toBe(false);
    expect(await repo.remove(id, U1)).toBe(true);
  });

  it("konuşma silinince mesajları da gider", async () => {
    const id = await repo.create(U1, "Benim");
    await repo.appendTurn(id, { question: "s", answer: "c" });
    await repo.remove(id, U1);
    expect(await db.conversationMessage.count()).toBe(0);
  });

  it("liste en yeniden eskiye sıralanır", async () => {
    const a = await repo.create(U1, "Eski");
    await new Promise((r) => setTimeout(r, 5));
    const b = await repo.create(U1, "Yeni");
    void a;
    const list = await repo.list(U1);
    expect(list[0]!.id).toBe(b);
  });

  it("tur eklemek konuşmayı listede yukarı taşır", async () => {
    const a = await repo.create(U1, "İlk");
    await new Promise((r) => setTimeout(r, 5));
    await repo.create(U1, "İkinci");
    await new Promise((r) => setTimeout(r, 5));
    await repo.appendTurn(a, { question: "s", answer: "c" });
    const list = await repo.list(U1);
    expect(list[0]!.id).toBe(a);
  });
});

/**
 * Demo modundaki senaryo seçimi.
 *
 * Geçmiş eklendiğinde ortaya çıkan gerçek bir hata: senaryo seçici ilk
 * kullanıcı mesajını okuyordu ve konuşma geçmişi gelince EN ESKİ soruyu
 * güncel soru sanmaya başladı. Kullanıcı "fabrikada ne oluyor?" diye
 * sorunca bir önceki turun banka cevabını aldı.
 */
describe("demo senaryo seçimi", () => {
  it("SON soruyu okur, ilkini değil", async () => {
    const { ScriptedCompleter } = await import("../src/ai/scripted.js");
    const completer = new ScriptedCompleter();
    const res = await completer.complete({
      messages: [
        { role: "user", content: "Bankada ne kadar param var?" },
        { role: "assistant", content: "12.400.000 TL." },
        { role: "user", content: "Peki fabrikada ne oluyor?" },
      ],
      // Senaryonun tool'u katalogda olmalı; yoksa completer reddeder.
      tools: [
        { name: "get_factory_wip", description: "", input_schema: {}, strict: true },
        { name: "get_bank_position", description: "", input_schema: {}, strict: true },
      ],
      task: "lookup",
      tenantId: "t",
      userId: "u",
      correlationId: "c",
    });
    const used = res.message.content.find((b) => b.type === "tool_use");
    expect((used as { name?: string } | undefined)?.name).toBe("get_factory_wip");
  });
});
