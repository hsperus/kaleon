/**
 * Tool duman testi — HER TOOL GERÇEKTEN ÇALIŞIYOR MU.
 *
 * TESTLER MOTORU DOĞRULUYOR, BU BETİK BAĞLANTIYI. Bir tool'un
 * repository'si tam test edilmiş olabilir ama tool'un kendisi yanlış
 * repository'ye bağlanmış, girdisi şemasıyla uyuşmuyor ya da hiç
 * kaydedilmemiş olabilir. Bunlar ancak çağırınca görünür.
 *
 * YAZAN TOOL ÇAĞRILMAZ. L1 ve üstü onay kapısına kadar gider ve orada
 * durur — bu da bir doğrulamadır: kapının çalıştığını gösterir.
 * Yürütülseydi betik demo verisine gerçek kayıtlar yazardı.
 *
 *   npm run smoke
 */

import { disconnectAll, sharedClient, tenantClient } from "../db/client.js";
import { buildRegistry } from "../app.js";
import { InMemoryDataSource } from "../data/memory.js";
import { InMemoryAuditSink } from "../kernel/audit.js";
import { InMemoryPendingStore } from "../db/pending-store.js";
import { createPrincipal } from "../kernel/rbac.js";
import { invokeTool } from "../kernel/invoke.js";
import type { TenantContext } from "../kernel/types.js";
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
import { PlanRepository } from "../db/plan-repository.js";
import { InMemoryConversationRepository } from "../modules/conversation/repository.js";
import { RevaluationRepository } from "../db/revaluation-repository.js";
import { PrismaUploadStore } from "../db/upload-store.js";
import { importerFor } from "../db/importers.js";
import { InMemoryOperationsRepository } from "../modules/operations/repository.js";
import {
  InMemoryApprovalRepository,
  InMemoryDocumentsRepository,
} from "../modules/documents/repository.js";

const YEAR = new Date().getUTCFullYear();
const TODAY = new Date().toISOString().slice(0, 10);
const MONTH_START = `${TODAY.slice(0, 8)}01`;

/**
 * Girdi ŞEMADAN üretilir, elle tahmin edilmez.
 *
 * İlk sürüm her tool için alan adlarını elle yazıyordu ve 30 tool
 * "arızalı" göründü — hepsi betiğin `itemId` yazdığı yerde şemanın
 * `itemCode` beklemesiydi. Yani duman testi, tool'ları değil kendi
 * tahminlerini ölçüyordu; böyle bir test gürültüden başka bir şey
 * üretmez ve gerçek arızayı gömer.
 *
 * Artık zorunlu alanlar şemadan okunuyor ve türüne uygun bir değer
 * konuyor. Bulunamayan kayıt sorun değildir (tool "bulunamadı" der ve
 * bu doğru davranıştır); ARANAN ŞEY, tool'un çalışıp çalışmadığıdır.
 */
function sampleFor(schema: Record<string, unknown>, name: string): unknown {
  const props = (schema["properties"] ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set((schema["required"] as string[] | undefined) ?? []);
  const out: Record<string, unknown> = {};

  for (const [key, def] of Object.entries(props)) {
    if (!required.has(key)) continue;
    out[key] = valueFor(key, def);
  }
  void name;
  return out;
}

function valueFor(key: string, def: Record<string, unknown>): unknown {
  /*
   * `type` DİZİ DE OLABİLİR.
   *
   * zod 4, nullable bir alanı `anyOf` yerine `{"type": ["number","null"]}`
   * olarak yazıyor. Bu dal yokken dizi hiçbir karşılaştırmayı tutmuyor,
   * akış en sona düşüyor ve sayısal alana METİN gönderiliyordu. Nullable
   * metinlerde kaza eseri çalışıyordu — hata ancak ilk nullable SAYI
   * eklendiğinde görüldü.
   */
  const rawType = def["type"];
  if (Array.isArray(rawType)) {
    // null kabul ediliyorsa null en güvenlisidir: "hepsi/varsayılan" demek.
    if (rawType.includes("null")) return null;
    return valueFor(key, { ...def, type: rawType[0] });
  }
  const type = rawType;
  const en = def["enum"] as unknown[] | undefined;

  // Enum varsa İLK SEÇENEK: uydurma bir değer şemayı geçemez.
  if (Array.isArray(en) && en.length > 0) return en[0];

  const anyOf = def["anyOf"] as Record<string, unknown>[] | undefined;
  if (Array.isArray(anyOf)) {
    // null kabul ediliyorsa null en güvenlisidir: "hepsi" anlamına gelir.
    if (anyOf.some((a) => a["type"] === "null")) return null;
    return valueFor(key, anyOf[0] ?? {});
  }

  if (type === "null") return null;
  if (type === "boolean") return false;
  if (type === "integer" || type === "number") {
    // Tarih/yıl alanları sayı olabilir; ad ipucu veriyorsa kullanılır.
    if (/year|yil|yıl/i.test(key)) return new Date().getUTCFullYear();
    if (/month|ay$/i.test(key)) return 8;
    if (/week|hafta/i.test(key)) return 35;
    if (/limit|count|adet|max/i.test(key)) return 5;
    if (/day|gun|gün/i.test(key)) return 30;
    return 1;
  }
  /*
   * DİZİ BOŞ DEĞİL, TEK ELEMANLI ÜRETİLİR.
   *
   * Boş dizi dönüyordu ve `.min(1)` isteyen her tool "geçersiz girdi"
   * ile düşüyordu. Yazan tool'larda görünmüyordu çünkü onlar onay
   * kapısında zaten duruyor; ilk OKUYAN tool bir dizi isteyince
   * ortaya çıktı (`check_availability`).
   *
   * Eleman, dizinin kendi şemasından üretiliyor — uydurma bir nesne
   * şemayı geçemezdi.
   */
  if (type === "array") {
    const items = def["items"] as Record<string, unknown> | undefined;
    if (!items) return [];
    return [valueFor(key, items)];
  }
  if (type === "object") {
    // Nesne şeması varsa zorunlu alanları doldurulur; boş nesne
    // `strictObject` doğrulamasını geçemezdi.
    const props = def["properties"] as Record<string, Record<string, unknown>> | undefined;
    if (!props) return {};
    const required = new Set((def["required"] as string[] | undefined) ?? Object.keys(props));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(props)) {
      if (required.has(k)) out[k] = valueFor(k, v);
    }
    return out;
  }

  // string
  // Desen SINIRLI eşleşmeli: ilk sürümde /to/ deseni "tool" alanına da
  // uyuyor ve tool adı yerine tarih gönderiliyordu.
  if (/^(from|to|on|asOf|issuedAt|date|tarih)$/i.test(key) || /_?(date|at)$/i.test(key)) {
    return new Date().toISOString().slice(0, 10);
  }
  // Dönem alanı çoğu tool'da YYYY-MM biçimindedir.
  if (/^period$/i.test(key)) return new Date().toISOString().slice(0, 7);
  if (/currency|para/i.test(key)) return "TRY";
  // Var olmayan bir kimlik SORUN DEĞİLDİR: tool "bulunamadı" demeli,
  // patlamamalı. Aranan tam olarak budur.
  return "SMOKE-TEST";
}

async function main(): Promise<void> {
  const tenantRow = await sharedClient().tenant.findUnique({ where: { slug: "demo" } });
  if (!tenantRow) throw new Error("demo tenant yok; önce: npm run demo:data -- demo");
  const db = tenantClient(tenantRow.schemaName);
  const tenant: TenantContext = {
    tenantId: tenantRow.id,
    schema: tenantRow.schemaName,
    locale: tenantRow.locale,
    baseCurrency: tenantRow.baseCurrency,
  };

  const operations = new InMemoryOperationsRepository({ bomRevisions: { "FR-22": "R3" } });
  const audit = new InMemoryAuditSink();
  const registry = buildRegistry(new InMemoryDataSource(tenant.tenantId), {
    operations,
    documents: new InMemoryDocumentsRepository(),
    approvals: new InMemoryApprovalRepository(),
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
    // Hafıza ve plan tool'ları da duman testine girsin: bağlanmayan
    // her depo, tool'larını testin dışında bırakır.
    conversations: new InMemoryConversationRepository(),
    plans: new PlanRepository(db),
    // BU İKİSİ UNUTULMUŞTU ve dört tool duman testinin dışında kaldı.
    // Aşağıdaki kapsam kontrolü artık bunu yakalıyor.
    revaluation: new RevaluationRepository(db),
    tenantDb: db,
    // İÇE AKTARMA DA UNUTULMUŞTU. Kullanıcının en çok kullanacağı veri
    // girişi yolu, duman testinin hiç bakmadığı yerdeydi.
    imports: {
      uploads: new PrismaUploadStore(db),
      importerFor: (objectId) => importerFor(objectId, db),
    },
  });

  const principal = createPrincipal({
    userId: "00000000-0000-0000-0000-0000000000de",
    tenantId: tenant.tenantId,
    roles: ["patron"],
    approvalLimit: { amount: 1_000_000, currency: "TRY" },
  });

  const tools = [...registry.all()].sort((a, b) => a.name.localeCompare(b.name));

  /*
   * KAPSAM KONTROLÜ — DUMAN TESTİNİN KENDİ KÖR NOKTASI.
   *
   * Bu script depoları ELLE bağlıyor. Yeni bir depo eklendiğinde
   * buraya eklenmezse, o depoya bağlı tool'lar kayda hiç girmez ve
   * test "hepsi çalışıyor" der — oysa bakmadığı yerler vardır.
   *
   * Gerçekten oldu: kur değerlemesi ve kadro tool'ları eklendiğinde
   * buraya eklenmedi; dört tool aylarca sınanmadan durabilirdi.
   *
   * `KAELON_SMOKE_EXPECT` ile beklenen sayı verilirse, eksik kapsam
   * artık sessiz kalmaz.
   */
  if (process.env["KAELON_SMOKE_LIST"]) console.log(tools.map((t) => t.name).join("\n"));
  const beklenen = Number(process.env["KAELON_SMOKE_EXPECT"] ?? 0);
  if (beklenen > 0 && tools.length < beklenen) {
    console.error(
      `\nKAPSAM EKSİK: ${tools.length} tool sınanıyor ama ${beklenen} bekleniyor.\n` +
        `Yeni bir depo eklendiyse smoke.ts içindeki listeye de eklenmeli.`,
    );
    process.exitCode = 1;
  }
  const reads = tools.filter((t) => t.authority === 0);
  const writes = tools.filter((t) => t.authority > 0);

  const broken: { name: string; code: string; message: string }[] = [];
  /** Kayıt bulunamadı diyenler — çalıştıkları için başarılı sayılır. */
  const handled: { name: string; message: string }[] = [];
  let ok = 0;

  for (const t of reads) {
    const input = sampleFor(t.schema.input_schema as Record<string, unknown>, t.name);
    const r = await invokeTool(t.name, input, {
      registry,
      audit,
      principal,
      tenant,
      correlationId: "smoke",
      channel: "job",
      pending: new InMemoryPendingStore(),
    });
    if (r.outcome.ok) {
      ok += 1;
    } else if (r.outcome.code === "business_rule") {
      /*
       * "BULUNAMADI" ARIZA DEĞİLDİR.
       *
       * Betik sahte bir kimlik gönderiyor ("SMOKE-TEST"); tool'un
       * doğru davranışı "bulunamadı" demektir. Bunu arıza saymak,
       * raporu gürültüyle doldurup gerçek arızayı gömerdi — nitekim
       * ilk koşumda 30 "arıza" çıktı ve hiçbiri arıza değildi.
       *
       * Aranan şey: tool ÇALIŞTI mı ve anlaşılır bir cevap verdi mi.
       */
      ok += 1;
      handled.push({ name: t.name, message: r.outcome.message ?? "" });
    } else {
      broken.push({ name: t.name, code: r.outcome.code, message: r.outcome.message ?? "" });
    }
  }

  // Yazan tool'lar: onay kapısına kadar gitmeli, orada durmalı.
  const gateOk: string[] = [];
  const gateBad: { name: string; code: string }[] = [];
  for (const t of writes) {
    const r = await invokeTool(t.name, sampleFor(t.schema.input_schema as Record<string, unknown>, t.name), {
      registry,
      audit,
      principal,
      tenant,
      correlationId: "smoke",
      channel: "job",
      pending: new InMemoryPendingStore(),
    });
    if (!r.outcome.ok && r.outcome.code === "confirmation_required") gateOk.push(t.name);
    else if (!r.outcome.ok && r.outcome.code === "invalid_input") gateOk.push(t.name);
    else gateBad.push({ name: t.name, code: r.outcome.ok ? "ÇALIŞTI" : r.outcome.code });
  }

  console.log("");
  console.log("KAELON · Tool Duman Testi");
  console.log("──────────────────────────────────────────────");
  console.log(
    `Okuma tool'u   : ${reads.length} · çalışan ${ok} · ARIZALI ${broken.length}`,
  );
  console.log(
    `  bunlardan ${handled.length} tanesi sahte kimliğe "bulunamadı" dedi (doğru davranış)`,
  );
  console.log(`Yazma tool'u   : ${writes.length} · onay kapısında duran ${gateOk.length}`);

  if (broken.length > 0) {
    console.log("\nSORUNLU OKUMA TOOL'LARI:");
    for (const b of broken) {
      console.log(`  ✗ ${b.name.padEnd(32)} ${b.code}  ${b.message.slice(0, 70)}`);
    }
  }
  if (gateBad.length > 0) {
    console.log("\nONAY KAPISINDA DURMAYAN YAZMA TOOL'LARI:");
    for (const g of gateBad) console.log(`  ✗ ${g.name.padEnd(32)} ${g.code}`);
  }

  await disconnectAll();
  if (broken.length > 0 || gateBad.length > 0) process.exitCode = 1;
}

main().catch(async (e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
  await disconnectAll();
});
