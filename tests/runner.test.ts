/**
 * Ajan döngüsü değişmezleri.
 *
 * Gateway sahte bir Completer ile değiştirilir; model çağrısı yapılmaz.
 * Test edilen şey modelin zekâsı değil, döngünün disiplinidir.
 */

import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";

import { runConversation } from "../src/ai/runner.js";
import type { CompleteRequest, CompleteResult, Completer } from "../src/ai/gateway.js";
import { buildRegistry } from "../src/app.js";
import { InMemoryDataSource } from "../src/data/memory.js";
import { InMemoryAuditSink } from "../src/kernel/audit.js";
import { createPrincipal } from "../src/kernel/rbac.js";
import { ToolRegistry } from "../src/kernel/registry.js";
import { defineTool } from "../src/kernel/tool.js";
import { z } from "zod";
import type { TenantContext } from "../src/kernel/types.js";

const TENANT: TenantContext = {
  tenantId: "t-orthaus",
  schema: "tenant_orthaus",
  locale: "tr-TR",
  baseCurrency: "TRY",
};

const patron = createPrincipal({ userId: "u1", tenantId: "t-orthaus", roles: ["patron"] });
const uretim = createPrincipal({ userId: "u3", tenantId: "t-orthaus", roles: ["uretim_muduru"] });

function msg(
  content: Anthropic.Beta.BetaContentBlock[],
  stop: Anthropic.Beta.BetaMessage["stop_reason"],
): Anthropic.Beta.BetaMessage {
  return {
    id: "m1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5",
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  } as unknown as Anthropic.Beta.BetaMessage;
}

function textBlock(text: string): Anthropic.Beta.BetaContentBlock {
  return { type: "text", text, citations: null } as unknown as Anthropic.Beta.BetaContentBlock;
}

function toolUse(id: string, name: string, input: unknown): Anthropic.Beta.BetaContentBlock {
  return { type: "tool_use", id, name, input } as unknown as Anthropic.Beta.BetaContentBlock;
}

/** Sırayla verilen cevapları döndüren ve gördüğü istekleri kaydeden sahte gateway. */
class ScriptedCompleter implements Completer {
  readonly seen: CompleteRequest[] = [];
  #queue: Anthropic.Beta.BetaMessage[];
  constructor(queue: Anthropic.Beta.BetaMessage[]) {
    this.#queue = queue;
  }
  async complete(req: CompleteRequest): Promise<CompleteResult> {
    // messages dizisi mutasyona uğradığı için kopyasını sakla
    this.seen.push({ ...req, messages: structuredClone(req.messages) });
    const message = this.#queue.shift();
    if (!message) throw new Error("Sahte gateway'de sıradaki cevap yok");
    return {
      message,
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
      costUsd: 0.001,
    };
  }
}

function deps(completer: Completer, audit = new InMemoryAuditSink()) {
  return {
    gateway: completer,
    registry: buildRegistry(new InMemoryDataSource("t-orthaus")),
    audit,
  };
}

const baseReq = {
  question: "Şu an fabrikada ne oluyor?",
  principal: patron,
  tenant: TENANT,
  correlationId: "c-1",
  channel: "chat" as const,
  task: "lookup" as const,
  display: { name: "Cebrail Karaarslan", roleLabel: "Patron", companyName: "Orthaus" },
  now: () => new Date("2026-05-16T07:42:00Z"),
};

describe("ajan döngüsü", () => {
  it("tool çağırır, sonucu besler ve nihai cevabı döndürür", async () => {
    const completer = new ScriptedCompleter([
      msg([toolUse("tu_1", "get_factory_wip", {})], "tool_use"),
      msg([textBlock("Şu an 142 aktif iş emri var, boya darboğaz.")], "end_turn"),
    ]);
    const audit = new InMemoryAuditSink();
    const res = await runConversation(deps(completer, audit), baseReq);

    expect(res.answer).toContain("142 aktif iş emri");
    expect(res.toolCalls).toEqual([
      expect.objectContaining({ tool: "get_factory_wip", ok: true }),
    ]);
    expect(res.iterations).toBe(2);
    expect(res.refused).toBe(false);
    expect(audit.entries.map((e) => e.toolName)).toEqual(["get_factory_wip"]);
    expect(audit.entries[0]?.aiContext?.toolUseId).toBe("tu_1");
  });

  it("paralel tool sonuçlarını TEK user mesajında döndürür", async () => {
    const completer = new ScriptedCompleter([
      msg(
        [
          toolUse("tu_1", "get_factory_wip", {}),
          toolUse("tu_2", "get_shipment_risk", { isoWeek: 19 }),
        ],
        "tool_use",
      ),
      msg([textBlock("İki kaynağı birleştirdim.")], "end_turn"),
    ]);
    const res = await runConversation(deps(completer), baseReq);
    expect(res.toolCalls).toHaveLength(2);

    // İkinci turda gönderilen mesajlar: user(soru), system, assistant, user(2 tool_result)
    const second = completer.seen[1]!;
    const last = second.messages.at(-1)!;
    expect(last.role).toBe("user");
    expect(Array.isArray(last.content)).toBe(true);
    const blocks = last.content as { type: string }[];
    expect(blocks.filter((b) => b.type === "tool_result")).toHaveLength(2);
  });

  it("modelin uydurduğu tool adı hata olarak geri beslenir", async () => {
    const completer = new ScriptedCompleter([
      msg([toolUse("tu_1", "get_secret_payroll", {})], "tool_use"),
      msg([textBlock("Bu bilgiye erişemiyorum.")], "end_turn"),
    ]);
    const res = await runConversation(deps(completer), baseReq);
    expect(res.toolCalls[0]).toMatchObject({ ok: false, code: "unknown_tool" });

    const second = completer.seen[1]!;
    const blocks = second.messages.at(-1)!.content as { type: string; is_error?: boolean }[];
    expect(blocks[0]?.is_error).toBe(true);
  });

  it("yetkisiz tool çağrısı reddedilir ve modele hata olarak döner", async () => {
    const completer = new ScriptedCompleter([
      msg([toolUse("tu_1", "get_bank_balance", { currency: null })], "tool_use"),
      msg([textBlock("Bu bilgi için yetkiniz yok.")], "end_turn"),
    ]);
    const audit = new InMemoryAuditSink();
    const res = await runConversation(deps(completer, audit), {
      ...baseReq,
      principal: uretim,
      question: "Euro bakiyesi ne kadar?",
    });
    expect(res.toolCalls[0]).toMatchObject({ ok: false, code: "permission_denied" });
    expect(audit.entries[0]?.outcome).toBe("denied");
  });

  it("üretim müdürüne banka tool'u hiç gönderilmez", async () => {
    const completer = new ScriptedCompleter([msg([textBlock("…")], "end_turn")]);
    await runConversation(deps(completer), { ...baseReq, principal: uretim });
    const names = completer.seen[0]!.tools.map((t) => t.name);
    expect(names).not.toContain("get_bank_balance");
    expect(names).toContain("get_factory_wip");
  });

  it("pause_turn'de asistan turunu geri iter ve devam eder", async () => {
    const completer = new ScriptedCompleter([
      msg([textBlock("arama sürüyor")], "pause_turn"),
      msg([textBlock("Tamamlandı.")], "end_turn"),
    ]);
    const res = await runConversation(deps(completer), baseReq);
    expect(res.answer).toBe("Tamamlandı.");
    expect(res.iterations).toBe(2);
  });

  it("refusal durumunda güvenli mesaj döner", async () => {
    const completer = new ScriptedCompleter([msg([], "refusal")]);
    const res = await runConversation(deps(completer), baseReq);
    expect(res.refused).toBe(true);
    expect(res.answer).toContain("güvenlik");
  });

  it("oturum bağlamı sistem mesajı olarak gider, sistem promptunu bozmaz", async () => {
    const completer = new ScriptedCompleter([msg([textBlock("…")], "end_turn")]);
    await runConversation(deps(completer), baseReq);
    const first = completer.seen[0]!;
    expect(first.messages[0]?.role).toBe("user");
    expect(first.messages[1]?.role).toBe("system");
    expect(String(first.messages[1]?.content)).toContain("Cebrail Karaarslan");
  });

  it("adım sınırı aşılırsa sonsuz döngüye girmez", async () => {
    const queue = Array.from({ length: 20 }, () =>
      msg([toolUse("tu_x", "get_factory_wip", {})], "tool_use"),
    );
    const res = await runConversation(deps(new ScriptedCompleter(queue)), baseReq);
    expect(res.stopReason).toBe("max_iterations");
    expect(res.iterations).toBe(8);
  });
});

/**
 * Dayanıklılık.
 *
 * Buradaki her test bir korumanın VARLIĞINI kanıtlar ve koruma kaldırılırsa
 * KIRILIR (BUILD-PLAN değişmez #8). Bir ERP'de tek bir asılı sorgu, tüm
 * ekranı sonsuza kadar bekletebilir; bunun testi olmayan bir koruma,
 * ilk yeniden düzenlemede sessizce kaybolur.
 */
describe("ajan döngüsü dayanıklılığı", () => {
  /**
   * Arızayı taklit eden gerçek bir tool.
   *
   * Üretim koduna "testte değiştir" kancası eklemek yerine, arızalı davranışı
   * olan gerçek bir tool kaydediyoruz. Kanca eklemek, üretimde çalışan kodda
   * yalnızca testin kullandığı bir yol açmak demektir; o yol bir gün başka
   * bir şey tarafından kullanılır.
   */
  function registryWithFaultyTool(execute: () => Promise<never>) {
    const tool = defineTool({
      name: "arizali_kaynak",
      module: "operations",
      authority: 0,
      deferLoading: false,
      description: { tr: "Test için arızalı kaynak.", en: "Faulty source for tests." },
      input: z.strictObject({}),
      requires: [],
      execute,
    });
    return new ToolRegistry().register(tool as unknown as Parameters<ToolRegistry["register"]>[0]);
  }

  it("TOOL ZAMAN AŞIMI: asılı kalan tool konuşmayı kilitlemez", async () => {
    const completer = new ScriptedCompleter([
      msg([toolUse("tu_1", "arizali_kaynak", {})], "tool_use"),
      msg([textBlock("Bu bilgiyi alamadım ama devam edebilirim.")], "end_turn"),
    ]);
    const d = {
      gateway: completer,
      // Asla bitmeyen tool.
      registry: registryWithFaultyTool(() => new Promise<never>(() => {})),
      audit: new InMemoryAuditSink(),
    };

    const res = await runConversation(d, { ...baseReq, toolTimeoutMs: 60 });

    expect(res.toolCalls[0]).toMatchObject({
      tool: "arizali_kaynak",
      ok: false,
      code: "tool_timeout",
    });
    expect(res.answer).toContain("devam edebilirim");
  });

  it("BEKLENMEYEN İSTİSNA konuşmayı öldürmez, modele hata olarak döner", async () => {
    const completer = new ScriptedCompleter([
      msg([toolUse("tu_1", "arizali_kaynak", {})], "tool_use"),
      msg([textBlock("Bu kaynağa şu an ulaşılamıyor.")], "end_turn"),
    ]);
    const d = {
      gateway: completer,
      registry: registryWithFaultyTool(async () => {
        throw new Error("veritabanı bağlantısı koptu");
      }),
      audit: new InMemoryAuditSink(),
    };

    const res = await runConversation(d, baseReq);
    expect(res.toolCalls[0]).toMatchObject({ ok: false });
    expect(res.answer).toContain("ulaşılamıyor");
  });

  it("İPTAL: kullanıcı vazgeçtiğinde döngü model çağırmaz", async () => {
    const completer = new ScriptedCompleter([msg([textBlock("olmamalı")], "end_turn")]);
    const controller = new AbortController();
    controller.abort();

    const res = await runConversation(deps(completer), { ...baseReq, signal: controller.signal });
    expect(res.stopReason).toBe("aborted");
    expect(completer.seen).toHaveLength(0);
  });

  it("SÜRE SINIRI: uzun konuşma elindeki bilgiyle biter", async () => {
    const completer = new ScriptedCompleter([msg([textBlock("olmamalı")], "end_turn")]);
    const res = await runConversation(deps(completer), { ...baseReq, deadlineMs: -1 });
    expect(res.stopReason).toBe("deadline");
    expect(res.answer).toContain("daraltıp");
  });

  it("GEÇMİŞ TURLAR modele metin olarak taşınır", async () => {
    const completer = new ScriptedCompleter([msg([textBlock("Geçen aya göre arttı.")], "end_turn")]);
    const res = await runConversation(deps(completer), {
      ...baseReq,
      question: "Peki ya geçen ay?",
      history: [{ question: "Bu ay mesai ne kadar?", answer: "42 saat." }],
    });

    const sent = completer.seen[0]!.messages;
    expect(sent[0]).toMatchObject({ role: "user", content: "Bu ay mesai ne kadar?" });
    expect(sent[1]).toMatchObject({ role: "assistant", content: "42 saat." });
    expect(sent[2]).toMatchObject({ role: "user", content: "Peki ya geçen ay?" });
    expect(res.answer).toContain("Geçen aya göre");
  });

  it("GEÇMİŞE TOOL SONUCU YAZILMAZ — bayat veri taze gibi okunmaz", async () => {
    const completer = new ScriptedCompleter([msg([textBlock("Tamam.")], "end_turn")]);
    await runConversation(deps(completer), {
      ...baseReq,
      history: [{ question: "Bakiye ne?", answer: "12.400.000 TL." }],
    });

    const sent = completer.seen[0]!.messages;
    const serialized = JSON.stringify(sent);
    expect(serialized).not.toContain("tool_result");
    expect(serialized).not.toContain("tool_use");
  });
});
