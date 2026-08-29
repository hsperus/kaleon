/**
 * Senaryo tabanlı Completer — model bağlı değilken kullanılır.
 *
 * NEDEN VAR: `ANTHROPIC_API_KEY` yokken uygulamanın çalışmaması, tüm zincirin
 * (RBAC → tool → audit → kaynak gösterimi) denenememesi demektir. Bu completer
 * gerçek modelin yerine geçmez; yalnızca hangi tool'un çağrılacağını basit
 * anahtar kelimeyle seçer ve zincirin geri kalanını GERÇEK haliyle çalıştırır.
 *
 * DÜRÜSTLÜK KURALI: bu mod devredeyken arayüz bunu açıkça yazar. "AI cevap
 * veriyor" izlenimi verilmez — çünkü vermiyor.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { CompleteRequest, CompleteResult, Completer } from "./gateway.js";

interface Rule {
  readonly match: readonly string[];
  readonly tool: string;
  readonly input: Record<string, unknown>;
  /** Tool sonucundan cevabı kuran şablon. */
  readonly render: (data: unknown) => string;
}

const tl = (n: unknown): string => Number(n ?? 0).toLocaleString("tr-TR");

const RULES: readonly Rule[] = [
  {
    match: ["fabrika", "üretim", "şu an", "atölye", "darboğaz"],
    tool: "get_factory_wip",
    input: {},
    render: (d) => {
      const w = d as {
        activeWorkOrders: number;
        staffOnShift: number | null;
        staffPlanned: number | null;
        machinesRunning: number | null;
        machinesTotal: number | null;
        actualRatePerHour: number | null;
        targetRatePerHour: number | null;
        stations: { station: string; utilizationPct: number | null; note: string }[];
      };
      // Bilinmeyen sayı "bilinmiyor" diye yazılır; ekranda "null" veya "NaN"
      // görmek kullanıcıya sistemin bozuk olduğunu düşündürür.
      const rate = (v: number | null) =>
        v === null ? "bilinmiyor" : `${v} birim/saat`;
      const staff = (a: number | null, b: number | null) =>
        a === null || b === null
          ? "Vardiyadaki personel sayısı bilinmiyor"
          : `${a}/${b} personel vardiyada`;
      const machines = (a: number | null, b: number | null) =>
        a === null || b === null
          ? "makine durumu bilinmiyor"
          : `${a}/${b} makine çalışıyor`;

      const measured = w.stations.filter(
        (x): x is typeof x & { utilizationPct: number } => x.utilizationPct !== null,
      );
      const bottleneck = [...measured].sort((a, b) => b.utilizationPct - a.utilizationPct)[0];

      const lines = [
        `Şu an ${w.activeWorkOrders} aktif iş emri var. ` +
          `${staff(w.staffOnShift, w.staffPlanned)}, ` +
          `${machines(w.machinesRunning, w.machinesTotal)}.`,
      ];
      if (bottleneck) {
        lines.push(
          `Darboğaz ${bottleneck.station} — %${bottleneck.utilizationPct} dolulukta (${bottleneck.note}).`,
        );
      }
      lines.push(
        `Gerçek hız ${rate(w.actualRatePerHour)}, hedef ${rate(w.targetRatePerHour)}.`,
      );
      return lines.join("\n\n");
    },
  },
  {
    match: ["sevkiyat", "gecik", "termin"],
    tool: "get_shipment_risk",
    input: { isoWeek: 19 },
    render: (d) => {
      const rows = d as { salesOrder: string; customer: string; slipDays: number; penaltyRiskTry: number }[];
      const total = rows.reduce((s, r) => s + r.penaltyRiskTry, 0);
      return (
        `${rows.length} sipariş gecikme riskinde:\n\n` +
        rows.map((r) => `• ${r.customer} ${r.salesOrder} — ${r.slipDays} gün`).join("\n") +
        `\n\nToplam ceza riski yaklaşık ${tl(total)} TL.`
      );
    },
  },
  {
    match: ["banka", "nakit", "bakiye", "kasa", "euro"],
    tool: "get_bank_balance",
    input: { currency: null },
    render: (d) => {
      const rows = d as { bank: string; currency: string; available: number; blocked: number }[];
      const byCurrency = new Map<string, number>();
      for (const r of rows) byCurrency.set(r.currency, (byCurrency.get(r.currency) ?? 0) + r.available);
      return (
        `Banka pozisyonu:\n\n` +
        [...byCurrency].map(([c, v]) => `• ${tl(v)} ${c}`).join("\n") +
        `\n\n${rows.length} hesap üzerinden toplandı.`
      );
    },
  },
  {
    match: ["mesai", "puantaj", "fazla çalışma"],
    tool: "get_overtime",
    input: { employeeQuery: null, department: null, period: "2026-05" },
    render: (d) => {
      const rows = d as {
        employeeName: string;
        weekdayMinutes: number;
        weekendMinutes: number;
        pendingApprovalMinutes: number;
      }[];
      return (
        rows
          .map((r) => {
            const total = r.weekdayMinutes + r.weekendMinutes;
            const pending = r.pendingApprovalMinutes;
            return (
              `• ${r.employeeName}: ${Math.floor(total / 60)} sa ${total % 60} dk` +
              (pending > 0 ? ` (${Math.round(pending / 60)} saati onay bekliyor)` : "")
            );
          })
          .join("\n") || "Kayıt bulunamadı."
      );
    },
  },
  {
    match: ["burçelik", "firma", "tedarikçi kim", "cari"],
    tool: "resolve_partner",
    input: { name: "Burçelik", taxId: null, externalSystem: null, externalId: null },
    render: (d) => {
      const r = d as { status: string; match?: { legalName: string; method: string; confidence: number } };
      if (r.status === "resolved" && r.match) {
        return (
          `"${r.match.legalName}" olarak çözüldü.\n\n` +
          `Eşleşme yöntemi: ${r.match.method}, güven ${Math.round(r.match.confidence * 100)}%.`
        );
      }
      return "Bu ada karşılık tek anlamlı bir firma bulunamadı; hangisini kastettiğinizi belirtir misiniz?";
    },
  },
];

function textBlock(text: string): Anthropic.Beta.BetaContentBlock {
  return { type: "text", text, citations: null } as unknown as Anthropic.Beta.BetaContentBlock;
}

function toolUse(name: string, input: unknown): Anthropic.Beta.BetaContentBlock {
  return { type: "tool_use", id: `demo_${name}`, name, input } as unknown as Anthropic.Beta.BetaContentBlock;
}

function message(
  content: Anthropic.Beta.BetaContentBlock[],
  stop: "tool_use" | "end_turn",
): Anthropic.Beta.BetaMessage {
  return {
    id: "demo",
    type: "message",
    role: "assistant",
    model: "demo-scripted",
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  } as unknown as Anthropic.Beta.BetaMessage;
}

const NO_MATCH =
  "Bu soruyu demo modunda cevaplayamıyorum. Model bağlı değil; yalnızca " +
  "üretim, sevkiyat, banka, mesai ve firma çözümleme senaryoları hazır. " +
  "Gerçek üründe bu soru intent çözümlemesinden geçer ve yetkiniz kontrol edilir.";

export class ScriptedCompleter implements Completer {
  async complete(req: CompleteRequest): Promise<CompleteResult> {
    const question = lastUserText(req.messages).toLocaleLowerCase("tr");
    const rule = RULES.find((r) => r.match.some((m) => question.includes(m)));
    const available = new Set(req.tools.map((t) => t.name));

    // Zaten bir tool sonucu geldiyse: cevabı kur.
    const toolResult = lastToolResult(req.messages);
    if (toolResult) {
      const parsed = safeParse(toolResult);
      if (parsed && typeof parsed === "object" && "ok" in parsed) {
        const outcome = parsed as { ok: boolean; data?: unknown; message?: string; sources?: unknown[] };
        if (!outcome.ok) {
          return done(message([textBlock(outcome.message ?? "İşlem tamamlanamadı.")], "end_turn"));
        }
        const body = rule ? rule.render(outcome.data) : JSON.stringify(outcome.data);
        const sources = (outcome.sources ?? []) as { system: string; syncedAt: string }[];
        const cite = sources.length
          ? `\n\nKaynak: ${sources.map((s) => s.system).join(" · ")} · son senkronizasyon ${new Date(sources[0]!.syncedAt).toLocaleString("tr-TR")}`
          : "";
        return done(message([textBlock(body + cite)], "end_turn"));
      }
    }

    if (!rule) return done(message([textBlock(NO_MATCH)], "end_turn"));

    // Yetki: tool listesinde yoksa model onu göremez — dürüstçe söyle.
    if (!available.has(rule.tool)) {
      return done(
        message(
          [textBlock("Bu bilgi için yetkiniz yok. Yöneticinizden erişim talep edebilirsiniz.")],
          "end_turn",
        ),
      );
    }

    return done(message([toolUse(rule.tool, rule.input)], "tool_use"));
  }
}

function done(m: Anthropic.Beta.BetaMessage): CompleteResult {
  return {
    message: m,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    costUsd: 0,
  };
}

/**
 * SON kullanıcı sorusu — ilki değil.
 *
 * Baştan taramak, konuşma geçmişi eklenene kadar doğru çalışıyordu çünkü ilk
 * kullanıcı mesajı zaten güncel soruydu. Geçmiş gelince aynı kod EN ESKİ
 * soruyu döndürmeye başladı: "peki fabrikada ne oluyor?" sorusuna bir önceki
 * turun banka cevabı verildi. Sondan taramak bunu kapatır.
 */
function lastUserText(messages: readonly Anthropic.Beta.BetaMessageParam[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "user" && typeof m.content === "string") return m.content;
  }
  return "";
}

function lastToolResult(messages: readonly Anthropic.Beta.BetaMessageParam[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "user" || typeof m.content === "string") continue;
    for (const block of m.content) {
      if ((block as { type?: string }).type === "tool_result") {
        const c = (block as { content?: unknown }).content;
        if (typeof c === "string") return c;
      }
    }
  }
  return null;
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
