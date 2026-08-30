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
import { InMemoryPendingStore } from "../db/pending-store.js";
import { createPrincipal } from "../kernel/rbac.js";
import type { TenantContext } from "../kernel/types.js";
import { InMemoryOperationsRepository } from "../modules/operations/repository.js";
import {
  InMemoryApprovalRepository,
  InMemoryDocumentsRepository,
} from "../modules/documents/repository.js";
import { createWorkOrder } from "../modules/operations/work-order.js";
import { GOLDEN_QUESTIONS, categoryBreakdown, type GoldenQuestion } from "./golden.js";
import { sharedClient, tenantClient, type TenantDb } from "../db/client.js";
import { PrismaItemRepository } from "../db/item-repository.js";
import { SalesRepository } from "../db/sales-repository.js";
import { ValuationRepository } from "../db/valuation-repository.js";
import { PeriodRepository } from "../db/period-repository.js";
import { BatchRepository } from "../db/batch-repository.js";
import { ProcurementRepository } from "../db/procurement-repository.js";
import { LeaveRepository } from "../db/leave-repository.js";
import { ChangeLogRepository } from "../db/change-log.js";
import { JournalRepository } from "../db/journal-repository.js";
import { StockCountRepository } from "../db/stock-count-repository.js";
import { MrpRepository } from "../db/mrp-repository.js";
import { EInvoiceRepository } from "../db/einvoice-repository.js";
import { CostingRepository } from "../db/costing-repository.js";
import { QuotationRepository } from "../db/quotation-repository.js";
import { MaintenanceRepository } from "../db/maintenance-repository.js";
import { DocumentFlowRepository } from "../db/document-flow-repository.js";
import { OrganizationRepository } from "../db/organization-repository.js";
import { CapacityRepository } from "../db/capacity-repository.js";
import { SerialRepository } from "../db/serial-repository.js";
import { AssetRepository } from "../db/asset-repository.js";
import { CreditNoteRepository } from "../db/credit-note-repository.js";
import { PayrollRepository } from "../db/payroll-repository.js";
import { WatchRepository } from "../db/watch-repository.js";
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

/**
 * Koşum dünyası.
 *
 * EVAL, ÜRÜNÜN TAMAMINI GÖRMELİDİR — VE GÖRMÜYORDU.
 *
 * Bu fonksiyon uzun süre yalnızca üç depoyu bağladı: operations,
 * documents, approvals. Sonuç şuydu — registry 138 tool yerine ~24
 * tool içeriyordu ve muhasebe, bordro, sabit kıymet, satış, izleme
 * tool'ları koşuma HİÇ girmiyordu. Yani "doğru tool'u seçiyor mu"
 * sorusunu cevaplayan tek mekanizma, ürünün beşte birine bakıyordu.
 *
 * Bu, tool etiketleri kapsam testinde ve şema koruma testinde de
 * yaşanan hatanın aynısı: deposuz kurulan registry sessizce eksik
 * kalıyor ve testler "sorun yok" diyor.
 *
 * Artık gerçek depolar DEMO ŞEMASINA bağlanıyor: demo tenant'ında
 * fatura, irsaliye, sabit kıymet, bordro ve açılış kaydı var, yani
 * tool'lar yalnızca kayıtlı değil ÇALIŞIR durumda. Veritabanı yoksa
 * (CI, ilk kurulum) eski davranışa düşülür ve bu AÇIKÇA yazılır —
 * sessizce eksik koşmak, hiç koşmamaktan kötüdür.
 */
function buildWorld(db: TenantDb | null) {
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
  const memory = {
    operations,
    documents: new InMemoryDocumentsRepository(),
    approvals: new InMemoryApprovalRepository(),
  };

  if (!db) return buildRegistry(new InMemoryDataSource(TENANT.tenantId), memory);

  const audit = new InMemoryAuditSink();
  return buildRegistry(new InMemoryDataSource(TENANT.tenantId), {
    ...memory,
    audit,
    items: new PrismaItemRepository(db),
    sales: new SalesRepository(db),
    valuation: new ValuationRepository(db),
    periods: new PeriodRepository(db),
    batches: new BatchRepository(db),
    procurement: new ProcurementRepository(db),
    leave: new LeaveRepository(db),
    changes: new ChangeLogRepository(db),
    journal: new JournalRepository(db),
    stockCounts: new StockCountRepository(db),
    mrp: new MrpRepository(db),
    einvoice: new EInvoiceRepository(db),
    costing: new CostingRepository(db),
    quotations: new QuotationRepository(db),
    maintenance: new MaintenanceRepository(db),
    flow: new DocumentFlowRepository(db),
    organization: new OrganizationRepository(db),
    capacity: new CapacityRepository(db),
    serials: new SerialRepository(db),
    assets: new AssetRepository(db),
    creditNotes: new CreditNoteRepository(db),
    payroll: new PayrollRepository(db),
    watches: new WatchRepository(db),
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
  db: TenantDb | null,
): Promise<GradeResult> {
  const registry = buildWorld(db);
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
        /*
         * ONAY DEPOSU KOŞUMDA DA OLMALIYDI — YOKTU.
         *
         * Deposuz koşumda YAZAN HER TOOL "Onay deposu yapılandırılmamış"
         * hatasıyla düşüyordu: 138 tool'un 63'ü, yani ürünün yazma
         * tarafının tamamı. Koşum modelin doğru tool'u seçtiğini
         * ölçebiliyordu ama seçtiği tool her zaman arızalı görünüyor ve
         * kalite skoru sahte biçimde düşüyordu.
         *
         * Bellek içi depo kullanılıyor ve ONAY VERİLMİYOR: amaç yazma
         * işlemini yürütmek değil, onay kapısının çalıştığını görmek.
         * Otomatik onay verilseydi koşum demo verisine gerçek kayıtlar
         * yazardı.
         */
        pending: new InMemoryPendingStore(),
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

  /*
   * DEMO ŞEMASINA BAĞLAN.
   *
   * Demo tenant'ında gerçek veri var: fatura, irsaliye, sabit kıymet,
   * bordro, açılış kaydı. Tool'lar orada yalnızca kayıtlı değil
   * ÇALIŞIR durumda — "doğru tool'u seçti mi" sorusunun yanında
   * "seçtiği tool cevap verdi mi" de ölçülür.
   *
   * Bağlanamazsa koşum durmaz ama EKSİK KOŞTUĞU AÇIKÇA YAZILIR.
   * Sessizce beşte biriyle koşmak, hiç koşmamaktan kötüdür: yeşil bir
   * rapor üretir ve kimse eksiği aramaz.
   */
  let db: TenantDb | null = null;
  try {
    const tenant = await sharedClient().tenant.findUnique({ where: { slug: "demo" } });
    if (tenant) db = tenantClient(tenant.schemaName);
  } catch {
    db = null;
  }

  console.log("");
  console.log("KAELON · Golden Question Koşumu");
  console.log("─".repeat(62));
  console.log(`Soru sayısı   : ${questions.length}${filter ? ` (filtre: ${filter})` : ""}`);
  console.log(`Model         : ${live ? "claude-opus-5 (canlı)" : "senaryo tabanlı (DEMO)"}`);
  // KAPSAM RAPORDA YAZAR. Eksik koşan bir eval, yeşil rapor üretip
  // eksiği gizler; kaç tool'la koşulduğu görünür olmalıdır.
  console.log(
    `Tool kapsamı  : ${buildWorld(db).all().length} tool` +
      (db ? " (demo şemasına bağlı)" : " · VERİTABANI YOK — EKSİK KOŞUM"),
  );
  if (!live) {
    console.log("");
    console.log("  ⚠ ANTHROPIC_API_KEY tanımlı değil. Aşağıdaki skor MODEL KALİTESİ");
    console.log("    hakkında hiçbir şey söylemez; yalnızca zincirin (RBAC, tool,");
    console.log("    audit, kaynak) ayakta olduğunu gösterir.");
  }
  console.log("");

  const results: GradeResult[] = [];
  for (const q of questions) {
    const r = await runOne(q, completer, db);
    results.push(r);
    const mark = r.passed ? "✓" : r.checks.some((c) => c.severity === "blocking" && !c.passed) ? "⛔" : "△";
    console.log(`  ${mark} ${q.id.padEnd(10)} ${q.question.slice(0, 52)}`);
    // DÜŞEN VAKADA ÇAĞRILAN TOOL'LAR YAZILIR. Olmadan teşhis
    // imkânsızdı: "zorunlu tool çağrılmadı" diyor ama modelin bunun
    // yerine ne seçtiğini söylemiyordu.
    if (!r.passed) {
      console.log(
        `     çağrılan: ${r.calledTools.length > 0 ? r.calledTools.join(", ") : "(hiç tool çağrılmadı)"}`,
      );
      for (const c of r.checks.filter((x) => !x.passed)) {
        console.log(`     ✗ ${c.name}: ${c.detail}`);
      }
      if (r.calledTools.length === 0) {
        // HİÇ TOOL ÇAĞRILMADIYSA TEK İPUCU CEVAPTIR.
        console.log(`     cevap: ${r.answer.slice(0, 220).replace(/\n/g, " ")}`);
      }
    }
  }

  const report = summarize(results);
  console.log("");
  console.log("─".repeat(62));
  console.log(formatReport(report));
  console.log("");
  console.log("Kategori dağılımı:", JSON.stringify(categoryBreakdown()));
  console.log("");

  /**
   * ÇIKIŞ KODU: DEMO KOŞUMU BİR HÜKÜM DEĞİLDİR.
   *
   * Model bağlı değilken senaryo tabanlı completer yalnızca birkaç soruyu
   * tanır; kalanlarda "zorunlu tool çağrılmadı" der. Bunu bir kalite açığı
   * gibi raporlamak ve CI'ı kırmak, ÖLÇÜLMEMİŞ bir şey hakkında hüküm
   * vermektir — en kötü rapor türü, yanlış olduğunu söylemeyen rapordur.
   *
   * Demo koşumunda yalnızca GÜVENLİK kategorisi bağlayıcıdır: yetkisiz bir
   * sorunun reddedilmesi modelin zekâsına değil RBAC zincirine bağlıdır ve
   * model olmadan da doğru çalışmak ZORUNDADIR.
   */
  const fatal = live
    ? report.blockingFailures
    : report.blockingFailures.filter((id) => categoryOf(id) === "security");

  if (fatal.length > 0) {
    console.error(
      `⛔ ${fatal.length} soruda güvenlik/davranış kapısı düştü. ` +
        `Bu bir kalite düşüşü değil, bir açıktır.`,
    );
    process.exitCode = 1;
    return;
  }

  if (!live) {
    console.log(
      "Demo koşumu: güvenlik kapıları geçti. Tool seçimi ve dürüstlük " +
        "başarımı ÖLÇÜLMEDİ — bunun için ANTHROPIC_API_KEY gerekir.",
    );
  }
}

function categoryOf(id: string): string | undefined {
  return GOLDEN_QUESTIONS.find((q) => q.id === id)?.category;
}

void main();
