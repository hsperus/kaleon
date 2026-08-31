/**
 * AI bütçe kapısı.
 *
 * Bu dosya somut bir hatadan doğdu: tavan yalnızca "lookup olmayan"
 * işler için geçerliydi ve sohbetin tamamı lookup olarak gittiği için
 * TAVAN HİÇ DEVREYE GİRMİYORDU. Koruma kodda duruyordu, okununca
 * çalışıyor gibi görünüyordu ve çalışmıyordu — bir korumanın
 * verebileceği en kötü hâl budur.
 *
 * Ayrıca defter bellekteydi: sunucu her yeniden başladığında harcama
 * sıfırlanıyordu, yani çalışan bir tavan bile dolmazdı.
 */

import { describe, expect, it } from "vitest";
import { LlmGateway, GatewayError } from "../src/ai/gateway.js";
import { InMemoryLedger, costOf, BudgetExceededError, type BudgetPolicy } from "../src/ai/ledger.js";
import { CONVERSATION_MODEL } from "../src/ai/model.js";

const BUDGET: BudgetPolicy = { warnUsd: 1, softCapUsd: 2, capUsd: 3 };

const CEVAP = {
  content: [{ type: "text", text: "ok" }],
  stop_reason: "end_turn",
  usage: {
    input_tokens: 10,
    output_tokens: 5,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  },
};

/**
 * Hiç ağa çıkmayan sahte istemci — test para harcamaz.
 *
 * AKIŞI DA TAKLİT EDER. Gateway artık `.stream()` kullanıyor; yalnızca
 * `.create()` taşıyan bir sahte, gerçekte olmayan bir hatayı
 * ("stream is not a function") her testte üretirdi. Parçalar da
 * yayınlanıyor ki `onTextDelta` sözleşmesi testte gerçekten koşsun.
 */
function fakeClient(parcalar: readonly string[] = ["o", "k"]) {
  return {
    beta: {
      messages: {
        stream: () => {
          const dinleyiciler: ((t: string) => void)[] = [];
          return {
            on(olay: string, cb: (t: string) => void) {
              if (olay === "text") dinleyiciler.push(cb);
              return this;
            },
            async finalMessage() {
              for (const p of parcalar) for (const d of dinleyiciler) d(p);
              return CEVAP;
            },
          };
        },
      },
    },
  } as never;
}

function gatewayWith(spentUsd: number) {
  const ledger = new InMemoryLedger();
  if (spentUsd > 0) {
    void ledger.record({
      at: new Date().toISOString(),
      tenantId: "t1",
      userId: "u1",
      correlationId: "seed",
      model: CONVERSATION_MODEL,
      costUsd: spentUsd,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  }
  return new LlmGateway({
    client: fakeClient(),
    ledger,
    systemPrompt: "test",
    budget: BUDGET,
  });
}

const request = (task: "lookup" | "analysis") => ({
  messages: [{ role: "user" as const, content: "test" }],
  tools: [],
  task,
  tenantId: "t1",
  userId: "u1",
  correlationId: "c1",
});

describe("bütçe kapısı", () => {
  it("eşiğin altında her iş çalışır", async () => {
    const gw = gatewayWith(0.5);
    await expect(gw.complete(request("lookup") as never)).resolves.toBeTruthy();
    await expect(gw.complete(request("analysis") as never)).resolves.toBeTruthy();
  });

  it("YUMUŞAK EŞİKTE PAHALI İŞ DURUR, OKUMA SÜRER", async () => {
    const gw = gatewayWith(2.5);
    await expect(gw.complete(request("analysis") as never)).rejects.toThrow(BudgetExceededError);
    await expect(gw.complete(request("lookup") as never)).resolves.toBeTruthy();
  });

  it("TAVANDA SOHBET DE DURUR — asıl hata buydu", async () => {
    // Önceki hâlinde `task !== "lookup"` koşulu yüzünden bu çağrı
    // geçiyordu ve tavan hiçbir zaman devreye girmiyordu.
    const gw = gatewayWith(3.5);
    await expect(gw.complete(request("lookup") as never)).rejects.toThrow(BudgetExceededError);
    await expect(gw.complete(request("analysis") as never)).rejects.toThrow(BudgetExceededError);
  });

  it("tavan mesajı harcanan ve sınır rakamını taşır", async () => {
    const gw = gatewayWith(3.5);
    try {
      await gw.complete(request("lookup") as never);
      throw new Error("beklenmedik");
    } catch (e) {
      expect((e as GatewayError).message).toContain("3.50");
      expect((e as GatewayError).message).toContain("3.00");
    }
  });

  it("tam eşikte de kapanır — sınır dahildir", async () => {
    const gw = gatewayWith(3);
    await expect(gw.complete(request("lookup") as never)).rejects.toThrow(BudgetExceededError);
  });
});

describe("maliyet hesabı", () => {
  it("önbellek okuması tam fiyattan ucuzdur", () => {
    const full = costOf(CONVERSATION_MODEL, {
      inputTokens: 10_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    const cached = costOf(CONVERSATION_MODEL, {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 10_000,
      cacheWriteTokens: 0,
    });
    expect(cached).toBeLessThan(full);
  });

  it("ÖNBELLEK YAZMAK OKUMAKTAN PAHALIDIR", () => {
    // İlk çağrı önbelleği yazar ve daha pahalıdır; sonrakiler ucuzlar.
    const write = costOf(CONVERSATION_MODEL, {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 10_000,
    });
    const read = costOf(CONVERSATION_MODEL, {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 10_000,
      cacheWriteTokens: 0,
    });
    expect(write).toBeGreaterThan(read);
  });

  it("bilinmeyen model sıfır maliyetli sayılmaz gibi görünse de sıfır döner", () => {
    // Fiyatı bilinmeyen bir model için uydurma fiyat üretmek, bütçeyi
    // yanlış hesaplatır; sıfır döner ve defterde görünür.
    expect(costOf("bilinmeyen-model", {
      inputTokens: 1000,
      outputTokens: 1000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })).toBe(0);
  });
});

/**
 * AKIŞ SÖZLEŞMESİ.
 *
 * Cevap tek blok hâlinde geliyordu: soğuk önbellekte ~20 saniye
 * boyunca ekranda hiçbir şey yoktu. Toplam süre aynı kalsa bile ilk
 * kelimenin ne zaman göründüğü ayrı bir şeydir ve kullanıcı bunu
 * "çok uzun sürdü" diye bildirdi.
 *
 * Burada test edilen şey hız değil — hızı test edemeyiz. Test edilen
 * şey, parçaların çağırana GERÇEKTEN ULAŞMASI: geri çağrı bağlanmasa
 * ya da sessizce düşürülse, ekran yine boş kalırdı ve hiçbir test
 * bunu görmezdi.
 */
describe("metin akışı", () => {
  it("parçalar geldikçe onTextDelta çağrılır", async () => {
    const gateway = new LlmGateway({
      client: fakeClient(["Nakit ", "akışı ", "hazır."]),
      ledger: new InMemoryLedger(),
      systemPrompt: "test",
      budget: BUDGET,
    });

    const parcalar: string[] = [];
    const r = await gateway.complete({
      messages: [{ role: "user", content: "nakit akışı" }],
      tools: [],
      task: "lookup",
      tenantId: "t1",
      userId: "u1",
      correlationId: "c1",
      onTextDelta: (t) => parcalar.push(t),
    });

    expect(parcalar).toEqual(["Nakit ", "akışı ", "hazır."]);
    // Tam mesaj yine dönüyor: akış, sonucun yerini ALMAZ.
    expect(r.message.stop_reason).toBe("end_turn");
  });

  it("geri çağrı verilmezse akış yine kurulur ve sonuç değişmez", async () => {
    const gateway = new LlmGateway({
      client: fakeClient(["a", "b"]),
      ledger: new InMemoryLedger(),
      systemPrompt: "test",
      budget: BUDGET,
    });
    const r = await gateway.complete({
      messages: [{ role: "user", content: "selam" }],
      tools: [],
      task: "lookup",
      tenantId: "t1",
      userId: "u1",
      correlationId: "c2",
    });
    expect(r.usage.outputTokens).toBe(5);
  });
});
