/**
 * İstek bağlamı — principal, tenant ve bağımlılıklar.
 *
 * KİMLİK SIRASI:
 *   1. Çerezdeki oturum (gerçek kimlik, `src/server/auth.ts`).
 *   2. Yalnızca GELİŞTİRMEDE: `x-kaelon-dev-role` başlığı, demo verisiyle rol
 *      davranışını göstermek için.
 * Üretimde 2. yol yoktur ve açan bir bayrak da yoktur. Oturum çözülemezse
 * `UnauthenticatedError` fırlar; uç noktalar bunu 401'e çevirir.
 *
 * VERİ DÜZLEMİ UYARISI:
 * Kimlik gerçek, veri düzlemi bu derlemede hâlâ demo (`InMemoryDataSource`).
 * Bu ayrım `dataPlane` alanıyla AÇIKÇA taşınır ve arayüzde gösterilir —
 * çünkü gerçek bir oturumla girip demo veri görmek, uyarılmadıkça yanıltıcıdır.
 */

import { createPrincipal } from "../kernel/rbac.js";
import type { Channel, Principal, RoleId, TenantContext } from "../kernel/types.js";
import { InMemoryAuditSink, type AuditEntry, type AuditSink } from "../kernel/audit.js";
import { PostgresAuditSink } from "../db/audit-sink.js";
import { InMemoryDataSource } from "../data/memory.js";
import { buildRegistry } from "../app.js";
import type { ToolRegistry } from "../kernel/registry.js";
import Anthropic from "@anthropic-ai/sdk";
import type { Completer } from "../ai/gateway.js";
import { LlmGateway } from "../ai/gateway.js";
import { ScriptedCompleter } from "../ai/scripted.js";
import { PostgresLedger } from "../ai/ledger.js";
import { SYSTEM_PROMPT } from "../ai/system-prompt.js";
import { createWorkOrder } from "../modules/operations/work-order.js";
import { principalFromSession } from "./auth.js";
import { startMaintenance } from "./maintenance.js";
import { sharedClient, tenantClient } from "../db/client.js";
import { PrismaDataSource } from "../db/master-data-source.js";
import { PrismaOperationsRepository } from "../db/operations-repository.js";
import { PrismaConversationRepository } from "../db/conversation-repository.js";
import { importerFor } from "../db/importers.js";
import { PrismaUploadStore } from "../db/upload-store.js";
import { SalesRepository } from "../db/sales-repository.js";
import { ValuationRepository } from "../db/valuation-repository.js";
import { PeriodRepository } from "../db/period-repository.js";
import { RevaluationRepository } from "../db/revaluation-repository.js";
import { BatchRepository } from "../db/batch-repository.js";
import { ProcurementRepository } from "../db/procurement-repository.js";
import { LeaveRepository } from "../db/leave-repository.js";
import { ChangeLogRepository } from "../db/change-log.js";
import { JournalRepository } from "../db/journal-repository.js";
import { StockCountRepository } from "../db/stock-count-repository.js";
import { MrpRepository } from "../db/mrp-repository.js";
import { DemoDataSource } from "../data/demo-source.js";
import { log } from "./log.js";
import { AssetRepository } from "../db/asset-repository.js";
import { CreditNoteRepository } from "../db/credit-note-repository.js";
import { PayrollRepository } from "../db/payroll-repository.js";
import { WatchRepository } from "../db/watch-repository.js";
import { EInvoiceRepository } from "../db/einvoice-repository.js";
import { CostingRepository } from "../db/costing-repository.js";
import { QuotationRepository } from "../db/quotation-repository.js";
import { MaintenanceRepository } from "../db/maintenance-repository.js";
import { DocumentFlowRepository } from "../db/document-flow-repository.js";
import { OrganizationRepository } from "../db/organization-repository.js";
import { CapacityRepository } from "../db/capacity-repository.js";
import { SerialRepository } from "../db/serial-repository.js";
import { InMemoryPendingStore, PrismaPendingStore } from "../db/pending-store.js";
import { singleton } from "./singleton.js";
import type { PendingStore } from "../kernel/pending.js";
import { PrismaItemRepository } from "../db/item-repository.js";
import {
  InMemoryConversationRepository,
  type ConversationRepository,
} from "../modules/conversation/repository.js";
import {
  PrismaApprovalRepository,
  PrismaDocumentsRepository,
} from "../db/documents-repository.js";

const DEV = process.env["NODE_ENV"] !== "production";

const VALID_ROLES: readonly RoleId[] = [
  "patron",
  "cfo",
  "ik_muduru",
  "uretim_muduru",
  "satin_alma",
  "depo_sorumlusu",
  "operator",
];

/**
 * Demo tenant.
 *
 * ARTIK GERÇEK BİR TENANT'TIR — kontrol düzleminde `demo` slug'ıyla bir
 * kaydı vardır ve tenantId onun UUID'sidir. Öncesinde uydurma bir "demo"
 * dizesiydi; gerçek oturumla girildiğinde principal'ın tenant'ı ile
 * bağlamın tenant'ı uyuşmuyor ve invoker haklı olarak `tenant_mismatch`
 * ile reddediyordu. Koruma doğruydu, bağlam yanlıştı.
 */
export const DEMO_SLUG = "demo";
const DEMO_COMPANY_NAME = "Demo A.Ş.";

/** Demo veri kümesinin bağlı olduğu tenant — açılışta çözülür. */
let demoTenant: TenantContext | null = null;
let demoSeeded = false;

export const ROLE_LABEL: Record<RoleId, string> = {
  patron: "Patron",
  cfo: "CFO",
  ik_muduru: "İK Müdürü",
  uretim_muduru: "Üretim Müdürü",
  satin_alma: "Satın Alma",
  depo_sorumlusu: "Depo Sorumlusu",
  operator: "Operatör",
};

/**
 * Model bağlı mı? Bağlı değilse arayüz bunu açıkça yazar.
 *
 * TESTTE ASLA BAĞLI DEĞİLDİR. Ortamda geçerli bir anahtar bulunması,
 * test koşusunun gerçek modele gidip PARA HARCAMASI anlamına gelirdi —
 * üstelik testler ağ ve model değişkenliğine bağlı hâle gelir, aynı kod
 * bir gün geçer bir gün kalırdı. Model yolu ayrı bir eval koşusuyla
 * sınanır; birim ve entegrasyon testleri betikli tamamlayıcıyla çalışır.
 */
const IN_TEST = Boolean(process.env["VITEST"] ?? process.env["VITEST_WORKER_ID"]);
export const MODEL_CONNECTED = !IN_TEST && Boolean(process.env["ANTHROPIC_API_KEY"]);

// ─── Süreç ömrü boyunca paylaşılan bağımlılıklar (demo verisi) ───

/**
 * Demo iş verisi. Süreç geneline bağlanır: onaylanan bir stok hareketi
 * `/api/trpc` içinde yazılır, sonraki soru `/api/ask` içinde okunur.
 */
/**
 * DENETİM KAYDI VERİTABANINA YAZILIR.
 *
 * Burada uzun süre `InMemoryAuditSink` duruyordu ve bu projenin en ciddi
 * kusuruydu: `PostgresAuditSink` yazılmış, tablosu tetikleyicilerle
 * değiştirilemez hâle getirilmiş, testleri yazılmıştı — ama uygulama onu
 * HİÇ ÇAĞIRMIYORDU. Her tool çağrısının izi bellekteki bir diziye gidiyor,
 * sunucu yeniden başlayınca yok oluyordu.
 *
 * "İz bırakmayan eylem yok" iddiası, izin kalıcı olmasına bağlıdır.
 * Değişmezlik tiyatrosu, hiç kayıt tutmamaktan daha tehlikelidir: kimse
 * kaydın olmadığını fark etmez.
 */
const auditByTenant = new Map<string, PostgresAuditSink>();

function auditFor(tenant: TenantContext): PostgresAuditSink {
  const cached = auditByTenant.get(tenant.tenantId);
  if (cached) return cached;
  const sink = new PostgresAuditSink(tenantClient(tenant.schema));
  auditByTenant.set(tenant.tenantId, sink);
  return sink;
}
/**
 * Harcama defteri KALICIDIR. Bellekte tutulsaydı sunucu her yeniden
 * başladığında harcama sıfırlanır ve aylık tavan hiçbir zaman dolmazdı —
 * geliştirme sırasında bu dakikada bir olur.
 */
const ledger = new PostgresLedger(sharedClient() as never);

/**
 * Demo iş emri — DEMO ŞEMASINA yazılır, belleğe değil.
 *
 * Önceden bellek deposuna yazılıyordu ve demo registry'si de bellekten
 * okuduğu için tutarlıydı. Demo artık gerçek şemadan okuduğuna göre,
 * belleğe yazılan bir iş emri hiçbir yerde görünmezdi.
 */
async function seedDemo(tenant: TenantContext): Promise<void> {
  if (demoSeeded) return;
  demoSeeded = true;
  const repo = new PrismaOperationsRepository(tenantClient(tenant.schema));
  await repo.saveWorkOrder(
    tenant.tenantId,
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
}

/**
 * Tenant bağlamını kontrol düzleminden okur.
 *
 * Şema adı UYGULAMADAN TÜRETİLMEZ, kayıttan okunur: slug'dan şema adı
 * hesaplamak, kaydın söylediğinden farklı bir şemaya yazma riski demektir.
 */
interface TenantEntry {
  readonly ctx: TenantContext;
  readonly name: string;
  readonly sector: string | null;
  readonly goals: string | null;
}

const tenantCache = new Map<string, TenantEntry>();

async function tenantContextById(tenantId: string): Promise<TenantEntry | null> {
  const cached = tenantCache.get(tenantId);
  if (cached) return cached;
  const row = await sharedClient().tenant.findUnique({ where: { id: tenantId } });
  if (!row || row.status !== "active") return null;
  const entry = {
    ctx: {
      tenantId: row.id,
      schema: row.schemaName,
      locale: row.locale,
      baseCurrency: row.baseCurrency,
    },
    name: row.name,
    sector: row.sector,
    goals: row.goals,
  };
  tenantCache.set(tenantId, entry);
  return entry;
}

async function demoTenantContext(): Promise<TenantContext> {
  if (demoTenant) return demoTenant;
  const row = await sharedClient().tenant.findUnique({ where: { slug: DEMO_SLUG } });
  if (!row) {
    throw new Error(
      `Demo tenant bulunamadı. Kurmak için: npm run tenant -- create ${DEMO_SLUG} "Demo A.Ş."`,
    );
  }
  demoTenant = {
    tenantId: row.id,
    schema: row.schemaName,
    locale: row.locale,
    baseCurrency: row.baseCurrency,
  };
  // Demo verisi eksikse akış çalışmaz; hata sessizce yutulmaz ama
  // uygulamayı da düşürmez — kullanıcı yine giriş yapabilmeli.
  await seedDemo(demoTenant).catch((e: unknown) => {
    log.warn("demo iş emri kurulamadı", { error: e instanceof Error ? e.message : String(e) });
  });
  return demoTenant;
}

/**
 * Registry demo tenant'ı çözüldükten SONRA kurulur.
 *
 * Demo veri kaynağı tek bir tenant'a bağlıdır ve o tenant'ın kimliği
 * kontrol düzleminden okunur; modül yüklenirken henüz bilinmiyor. Sabit
 * bir "demo" dizesiyle kurmak, principal'ın gerçek tenant'ıyla uyuşmayan
 * bir bağlam üretiyordu.
 */
const registryByTenant = new Map<string, ToolRegistry>();

/**
 * Yüklenen dosya deposu — tenant'ın kendi şemasında.
 *
 * Süreç belleğinde tutulamaz: yüklemeyi alan sunucu ile soruyu alan sunucu
 * aynı olmak zorunda kalırdı. Bu varsayım çok örnekli üretimde ve hatta
 * geliştirmede modül yeniden yüklendiğinde kırılıyor.
 */
export function uploadStoreFor(tenant: TenantContext): PrismaUploadStore {
  return new PrismaUploadStore(tenantClient(tenant.schema));
}
/**
 * DEMO KONUŞMALARI BELLEKTEDİR ve route'lar arasında paylaşılmalıdır:
 * konuşma `/api/ask` içinde büyür, `/api/trpc` içinde okunur. Modül
 * değişkeni olsaydı geçmiş listesi boş görünürdü.
 */
const conversationsByTenant = singleton(
  "conversations.byTenant",
  () => new Map<string, ConversationRepository>(),
);

/**
 * Konuşma deposu — tenant başına.
 *
 * Demo tenant'ı bellekte tutar (sunucu yeniden başlayınca sıfırlanır, demo
 * için doğru davranış); gerçek tenant kendi şemasına yazar.
 */
function conversationsFor(tenant: TenantContext, isDemo: boolean): ConversationRepository {
  const cached = conversationsByTenant.get(tenant.tenantId);
  if (cached) return cached;
  const repo: ConversationRepository = isDemo
    ? new InMemoryConversationRepository()
    : new PrismaConversationRepository(tenantClient(tenant.schema));
  conversationsByTenant.set(tenant.tenantId, repo);
  return repo;
}

/**
 * Tenant'ın registry'si.
 *
 * DEMO TENANT'I DA TAM REGISTRY'Yİ ALIR. Önceden demo, bellek
 * kaynağıyla kurulduğu için 114 tool'un 24'ünü gösteriyordu: muhasebe,
 * MRP, e-Fatura, bakım, İK demoda yoktu ve ürünü ilk kez gören kişi
 * olanın beşte birini görüyordu. Ayrım artık doğru yerde — yalnızca
 * ADAPTÖRÜ OLMAYAN DIŞ KANALLAR (banka, sevkiyat, WIP, mesai) bellekten
 * gelir; geri kalan her şey demo şemasının kendi Postgres verisinden
 * okunur. Böylece demoda yazılan bir kayıt yine demoda okunur.
 *
 * Registry tenant başına önbelleklenir çünkü tool şemaları prompt
 * önbelleğinin ön ekindedir; her istekte yeniden kurmak sırayı bozup
 * önbelleği ıskalatırdı.
 */
function registryFor(tenant: TenantContext, isDemo: boolean): ToolRegistry {
  const cached = registryByTenant.get(tenant.tenantId);
  if (cached) return cached;

  const registry = buildRegistryForTenant(tenant, isDemo);
  registryByTenant.set(tenant.tenantId, registry);
  return registry;
}

function buildRegistryForTenant(tenant: TenantContext, isDemo = false): ToolRegistry {
  const db = tenantClient(tenant.schema);
  const real = new PrismaDataSource(db);
  // Demoda dış kanallar gösteri kümesinden, geri kalan gerçek şemadan.
  const source = isDemo
    ? new DemoDataSource(new InMemoryDataSource(tenant.tenantId), real)
    : real;
  return buildRegistry(source, {
    operations: new PrismaOperationsRepository(db),
    documents: new PrismaDocumentsRepository(db),
    approvals: new PrismaApprovalRepository(db),
    items: new PrismaItemRepository(db),
    sales: new SalesRepository(db),
    valuation: new ValuationRepository(db),
    periods: new PeriodRepository(db),
    revaluation: new RevaluationRepository(db),
    batches: new BatchRepository(db),
    procurement: new ProcurementRepository(db),
    leave: new LeaveRepository(db),
    changes: new ChangeLogRepository(db),
    journal: new JournalRepository(db),
    assets: new AssetRepository(db),
    creditNotes: new CreditNoteRepository(db),
    payroll: new PayrollRepository(db),
    watches: new WatchRepository(db),
    audit: auditFor(tenant),
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
    imports: {
      uploads: new PrismaUploadStore(db),
      // Yazıcı, isteğin tenant'ına bağlı client ile kurulur; tool içinden
      // gelen tenantId bağlamla aynıdır (invoker bunu doğrular).
      importerFor: (objectId) => importerFor(objectId, db),
    },
  });
}

/**
 * Tenant başına onay deposu.
 *
 * Demo tenant'ta bellek içi karşılık kullanılır: demo verisi kalıcı
 * değildir ve onay akışının kendisi aynı şekilde çalışır.
 */
const pendingByTenant = singleton("pending.byTenant", () => new Map<string, PendingStore>());

function pendingFor(tenant: TenantContext, isDemo: boolean): PendingStore {
  const cached = pendingByTenant.get(tenant.tenantId);
  if (cached) return cached;
  const store = isDemo ? new InMemoryPendingStore() : new PrismaPendingStore(tenantClient(tenant.schema));
  pendingByTenant.set(tenant.tenantId, store);
  return store;
}

let completerSingleton: Completer | null = null;

function getCompleter(): Completer {
  completerSingleton ??= MODEL_CONNECTED
    ? new LlmGateway({ client: new Anthropic(), ledger, systemPrompt: SYSTEM_PROMPT })
    : new ScriptedCompleter();
  return completerSingleton;
}

export interface RequestContext {
  readonly principal: Principal;
  readonly tenant: TenantContext;
  readonly channel: Channel;
  readonly registry: ToolRegistry;
  readonly audit: AuditSink;
  readonly completer: Completer;
  /** Son kayıtları okumak için — arayüzdeki denetim izi paneli. */
  readonly recentAudit: (limit?: number) => Promise<readonly AuditEntry[]>;
  readonly conversations: ConversationRepository;
  /**
   * Onay bekleyen işlemler.
   *
   * Her istekte hazır olmalı: yazma tool'ları bunsuz çalışmaz ve
   * "yapılandırılmamışsa onayı atla" davranışı kabul edilemez.
   */
  readonly pending: PendingStore;
  /**
   * Kullanıcı tanımlı izlemeler.
   *
   * Brifing motoruna verilir; her istekte hazır olmalı çünkü açılış
   * ekranı bunsuz eksik çalışır ve kullanıcı kurduğu uyarıyı göremez.
   */
  readonly watches: WatchRepository;
  /** Kimliğin nereden geldiği — arayüzde ve denetim kaydında görünür. */
  readonly identitySource: "session" | "dev-header";
  /** Kullanıcının görünen adı. Artık sabit yazılı değil. */
  readonly displayName: string;
  /** Şirketin görünen adı — kimliği değil. */
  readonly companyName: string;
  /*
   * ŞİRKET PROFİLİ — AJANIN NEYE DİKKAT EDECEĞİ.
   *
   * Sektör ve öncelikler cevabın TONUNU belirler, RAKAMINI değil.
   * Bir dökümhaneye tekstil örneği vermemek, bir ihracatçıya kur
   * riskini hatırlatmak için. Hiçbir hesaba girmez, hiçbir yetkiyi
   * genişletmez; yanlış girilmiş bir sektör yanlış rakam üretmez.
   */
  readonly sector: string | null;
  readonly goals: string | null;
  /**
   * Verinin durumu — arayüzde AÇIKÇA gösterilir.
   *   "demo"     → demo tenant'ının hazır veri kümesi
   *   "postgres" → gerçek tenant, veri kendi şemasından geliyor
   * Gerçek bir şirkete girip demo rakamları görmek yanıltıcı olurdu; bu
   * yüzden demo verisi YALNIZCA demo tenant'ına bağlıdır.
   */
  readonly dataPlane: "demo" | "postgres";
}

/** Oturum yok/geçersiz. Uç noktalar 401 döner. */
export class UnauthenticatedError extends Error {
  constructor() {
    super("Oturum bulunamadı veya süresi dolmuş.");
    this.name = "UnauthenticatedError";
  }
}

function devRole(req: Request): RoleId {
  const raw = req.headers.get("x-kaelon-dev-role");
  return VALID_ROLES.find((r) => r === raw) ?? "patron";
}

export async function createContext(req: Request): Promise<RequestContext> {
  // Bakım işi ilk istekte başlar. `instrumentation.ts` içinden başlatmak,
  // Prisma'yı edge paketine sürükleyip uygulamayı açılmaz hâle getiriyordu.
  startMaintenance();

  const base = {
    channel: "chat" as Channel,
    completer: getCompleter(),
  };

  // 1. Gerçek oturum
  const identity = await principalFromSession(req);
  if (identity) {
    const found = await tenantContextById(identity.principal.tenantId);
    // Tenant askıya alınmış veya silinmişse oturum geçerli olsa da giriş yok.
    if (!found) throw new UnauthenticatedError();
    const tenant = found.ctx;
    const demo = await demoTenantContext().catch(() => null);
    const isDemo = demo?.tenantId === tenant.tenantId;
    return {
      ...base,
      registry: registryFor(tenant, isDemo),
      conversations: conversationsFor(tenant, isDemo),
      pending: pendingFor(tenant, isDemo),
      audit: auditFor(tenant),
      watches: new WatchRepository(tenantClient(tenant.schema)),
      recentAudit: (limit) => auditFor(tenant).recent(tenant.tenantId, limit),
      tenant,
      principal: identity.principal,
      identitySource: "session",
      displayName: identity.displayName,
      companyName: found.name,
      sector: found.sector,
      goals: found.goals,
      dataPlane: isDemo ? "demo" : "postgres",
    };
  }

  // 2. Geliştirme rolü — üretimde bu satıra gelinmez.
  if (!DEV) throw new UnauthenticatedError();

  const tenant = await demoTenantContext();
  return {
    ...base,
    registry: registryFor(tenant, true),
    conversations: conversationsFor(tenant, true),
    pending: pendingFor(tenant, true),
    audit: auditFor(tenant),
    watches: new WatchRepository(tenantClient(tenant.schema)),
    recentAudit: (limit) => auditFor(tenant).recent(tenant.tenantId, limit),
    tenant,
    identitySource: "dev-header",
    displayName: "Cebrail Karaarslan (demo)",
    companyName: DEMO_COMPANY_NAME,
    sector: "Makina imalatı",
    goals: null,
    dataPlane: "demo",
    principal: createPrincipal({
      userId: "00000000-0000-0000-0000-0000000000de",
      tenantId: tenant.tenantId,
      roles: [devRole(req)],
      approvalLimit: { amount: 1_000_000, currency: "TRY" },
    }),
  };
}
