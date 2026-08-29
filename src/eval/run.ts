/**
 * Golden question koşumu.
 *
 *   npm run eval              → bağlı olan completer ile koşar
 *   npm run eval -- --filter SEC   → yalnızca kimliği SEC ile başlayanlar
 *
 * ANTHROPIC_API_KEY varsa gerçek Opus 5'e, yoksa senaryo tabanlı completer'a
 * karşı koşar. İkinci durumda rapor bunu AÇIKÇA yazar — demo modundaki bir
 * skor, model kalitesi hakkında hiçbir şey söylemez ve öyle sunulmamalıdır.
 *
 * ÇIKIŞ KODU: güvenlik/davranış kapılarından biri düşerse 1 döner. Böylece
 * CI'da bir yetki sızıntısı, derleme hatası kadar sert durdurur.
 */

import Anthropic from "@anthropic-ai/sdk";
import { runConversation } from "../ai/runner.js";
import { ScriptedCompleter } from "../ai/scripted.js";
import { LlmGateway, type Completer } from "../ai/gateway.js";
import { InMemoryLedger } from "../ai/ledger.js";
import { SYSTEM_PROMPT } from "../ai/system-prompt.js";
import { buildRegistry } from "../app.js";
import { InMemoryDataSource } from "../data/memory.js";
import { InMemoryAuditSink } from "../kernel/audit.js";
import { createPrincipal } from "../kernel/rbac.js";
import type { TenantContext } from "../kernel/types.js";
import { InMemoryOperationsRepository } from "../modules/operations/repository.js";
import {
  InMemoryApprovalRepository,
  InMemoryDocumentsRepository,
} from "../modules/documents/repository.js";
import { createWorkOrder } from "../modules/operations/work-order.js";
import { GOLDEN_QUESTIONS, categoryBreakdown, type GoldenQuestion } from "./golden.js";
import { formatReport, grade, summarize, type GradeResult } from "./grade.js";

const TENANT: TenantContext = {
  tenantId: "eval",
  schema: "tenant_eval",
  locale: "tr-TR",
  baseCurrency: "TRY",
};

const ROLE_LABEL: Record<string, string> = {
  patron: "Patron",
  cfo: "CFO",
  ik_muduru: "İK Müdürü",
  uretim_muduru: "Üretim Müdürü",
  satin_alma: "Satın Alma",
  depo_sorumlusu: "Depo Sorumlusu",
  operator: "Operatör",
};

function buildWorld() {
  const operations = new InMemoryOperationsRepository({ bomRevisions: { "FR-22": "R3" } });
  void operations.saveWorkOrder(
    TENANT.tenantId,
    createWorkOrder({
      id: "WO-2026-0612",
      itemId: "FR-22",
      quantity: 10,
      routing: [
        { seq: 10, workCenter: "KESIM", description: "Profil kesimi", gate: null },
        {
          seq: 20,
          workCenter: "KAYNAK",
          description: "Şasi kaynağı",
          gate: { characteristic: "Kaynak penetrasyonu", decidedBy: "quality:gate.release" },
        },
        { seq: 30, workCenter: "BOYA", description: "Boya", gate: null },
      ],
    }),
  );
  return buildRegistry(new InMemoryDataSource(), {
    operations,
    documents: new InMemoryDocumentsRepository(),
    approvals: new InMemoryApprovalRepository(),
  });
}

function makeCompleter(): { completer: Completer; live: boolean } {
  if (process.env["ANTHROPIC_API_KEY"]) {
    return {
      completer: new LlmGateway({
        client: new Anthropic(),
        ledger: new InMemoryLedger(),
        systemPrompt: SYSTEM_PROMPT,
      }),
      live: true,
    };
  }
  return { completer: new ScriptedCompleter(), live: false };
}

async function runOne(
  q: GoldenQuestion,
  completer: Completer,
): Promise<GradeResult> {
  const registry = buildWorld();
  const audit = new InMemoryAuditSink();
  const principal = createPrincipal({
    userId: "00000000-0000-0000-0000-0000000000ev",
    tenantId: TENANT.tenantId,
    roles: [q.askedBy],
    approvalLimit: { amount: 1_000_000, currency: "TRY" },
  });

  try {
    const run = await runConversation(
      { gateway: completer, registry, audit },
      {
        question: q.question || "…",
        principal,
        tenant: TENANT,
        correlationId: `eval-${q.id}`,
        channel: "chat",
        task: "lookup",
        display: {
          name: "Cebrail Karaarslan",
          roleLabel: ROLE_LABEL[q.askedBy] ?? q.askedBy,
          companyName: "Orthaus",
        },
      },
    );
    return grade(q, run);
  } catch (e) {
    return grade(q, {
      answer: `KOŞUM HATASI: ${(e as Error).message}`,
      toolCalls: [],
      iterations: 0,
      costUsd: 0,
      stopReason: "error",
      refused: false,
    });
  }
}

async function main(): Promise<void> {
  const filterArg = process.argv.indexOf("--filter");
  const filter = filterArg > -1 ? process.argv[filterArg + 1] : null;
  const questions = filter
    ? GOLDEN_QUESTIONS.filter((q) => q.id.startsWith(filter) || q.category === filter)
    : GOLDEN_QUESTIONS;

  const { completer, live } = makeCompleter();

  console.log("");
  console.log("KAELON · Golden Question Koşumu");
  console.log("─".repeat(62));
  console.log(`Soru sayısı   : ${questions.length}${filter ? ` (filtre: ${filter})` : ""}`);
  console.log(`Model         : ${live ? "claude-opus-5 (canlı)" : "senaryo tabanlı (DEMO)"}`);
  if (!live) {
    console.log("");
    console.log("  ⚠ ANTHROPIC_API_KEY tanımlı değil. Aşağıdaki skor MODEL KALİTESİ");
    console.log("    hakkında hiçbir şey söylemez; yalnızca zincirin (RBAC, tool,");
    console.log("    audit, kaynak) ayakta olduğunu gösterir.");
  }
  console.log("");

  const results: GradeResult[] = [];
  for (const q of questions) {
    const r = await runOne(q, completer);
    results.push(r);
    const mark = r.passed ? "✓" : r.checks.some((c) => c.severity === "blocking" && !c.passed) ? "⛔" : "△";
    console.log(`  ${mark} ${q.id.padEnd(10)} ${q.question.slice(0, 52)}`);
  }

  const report = summarize(results);
  console.log("");
  console.log("─".repeat(62));
  console.log(formatReport(report));
  console.log("");
  console.log("Kategori dağılımı:", JSON.stringify(categoryBreakdown()));
  console.log("");

  // Güvenlik kapısı düştüyse CI'ı durdur.
  if (report.blockingFailures.length > 0) {
    console.error(
      `⛔ ${report.blockingFailures.length} soruda güvenlik/davranış kapısı düştü. ` +
        `Bu bir kalite düşüşü değil, bir açıktır.`,
    );
    process.exitCode = 1;
  }
}

void main();
