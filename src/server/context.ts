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
import { InMemoryAuditSink, type AuditSink } from "../kernel/audit.js";
import { InMemoryDataSource } from "../data/memory.js";
import { InMemoryOperationsRepository } from "../modules/operations/repository.js";
import {
  InMemoryApprovalRepository,
  InMemoryDocumentsRepository,
} from "../modules/documents/repository.js";
import { buildRegistry } from "../app.js";
import type { ToolRegistry } from "../kernel/registry.js";
import Anthropic from "@anthropic-ai/sdk";
import type { Completer } from "../ai/gateway.js";
import { LlmGateway } from "../ai/gateway.js";
import { ScriptedCompleter } from "../ai/scripted.js";
import { InMemoryLedger } from "../ai/ledger.js";
import { SYSTEM_PROMPT } from "../ai/system-prompt.js";
import { createWorkOrder } from "../modules/operations/work-order.js";
import { principalFromSession } from "./auth.js";
import { sharedClient, tenantClient } from "../db/client.js";
import { PrismaDataSource } from "../db/master-data-source.js";
import { PrismaOperationsRepository } from "../db/operations-repository.js";
import { PrismaConversationRepository } from "../db/conversation-repository.js";
import { PartnerImporter } from "../db/partner-import.js";
import { InMemoryUploadStore } from "../modules/import/uploads.js";
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

/** Model bağlı mı? Bağlı değilse arayüz bunu açıkça yazar. */
export const MODEL_CONNECTED = Boolean(process.env["ANTHROPIC_API_KEY"]);

// ─── Süreç ömrü boyunca paylaşılan bağımlılıklar (demo verisi) ───

const operations = new InMemoryOperationsRepository({ bomRevisions: { "FR-22": "R3" } });
const documents = new InMemoryDocumentsRepository();
const approvals = new InMemoryApprovalRepository();
const audit: AuditSink = new InMemoryAuditSink();
const ledger = new InMemoryLedger();

async function seedDemo(tenantId: string): Promise<void> {
  if (demoSeeded) return;
  demoSeeded = true;
  await operations.saveWorkOrder(
    tenantId,
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
const tenantCache = new Map<string, { ctx: TenantContext; name: string }>();

async function tenantContextById(
  tenantId: string,
): Promise<{ ctx: TenantContext; name: string } | null> {
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
  await seedDemo(demoTenant.tenantId);
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
 * Yüklenen dosyalar — süreç ömrü boyunca, tenant sınırlı, süreli.
 * Tek bir depo yeterli: tenant kontrolü deponun içinde yapılıyor.
 */
export const uploads = new InMemoryUploadStore();
const conversationsByTenant = new Map<string, ConversationRepository>();

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
 * DEMO TENANT'I bellek kaynağını ve bellek depolarını kullanır — hazır veri
 * kümesi oradadır. GERÇEK TENANT Postgres'e bağlanır; henüz adaptörü olmayan
 * kanallar (banka, mesai, sevkiyat, WIP) boş döner, uydurma veri dönmez.
 *
 * Registry tenant başına önbelleklenir çünkü tool şemaları prompt önbelleğinin
 * ön ekindedir; her istekte yeniden kurmak sırayı bozup önbelleği ıskalatırdı.
 */
function registryFor(tenant: TenantContext, isDemo: boolean): ToolRegistry {
  const cached = registryByTenant.get(tenant.tenantId);
  if (cached) return cached;

  /**
   * DEMO TENANT'INDA İÇE AKTARMA TOOL'LARI YOKTUR.
   *
   * Demo verisi bellekte sabit bir gösteri kümesidir. İçe aktarma gerçek
   * şemaya yazardı; kullanıcı cari eklerdi ama `resolve_partner` bellekten
   * okuduğu için onu BULAMAZDI. "Ekledim ama yok" hâli, tool'un hiç
   * olmamasından çok daha kötüdür. Gerçek tenant'ta zincirin tamamı çalışır.
   */
  const registry = isDemo
    ? buildRegistry(new InMemoryDataSource(tenant.tenantId), {
        operations,
        documents,
        approvals,
      })
    : buildRegistryForTenant(tenant);

  registryByTenant.set(tenant.tenantId, registry);
  return registry;
}

function buildRegistryForTenant(tenant: TenantContext): ToolRegistry {
  const db = tenantClient(tenant.schema);
  return buildRegistry(new PrismaDataSource(db), {
    operations: new PrismaOperationsRepository(db),
    documents: new PrismaDocumentsRepository(db),
    approvals: new PrismaApprovalRepository(db),
    imports: {
      uploads,
      // Yazıcı, isteğin tenant'ına bağlı client ile kurulur; tool içinden
      // gelen tenantId bağlamla aynıdır (invoker bunu doğrular).
      importerFor: () => new PartnerImporter(db),
    },
  });
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
  readonly auditSink: InMemoryAuditSink;
  readonly conversations: ConversationRepository;
  /** Kimliğin nereden geldiği — arayüzde ve denetim kaydında görünür. */
  readonly identitySource: "session" | "dev-header";
  /** Kullanıcının görünen adı. Artık sabit yazılı değil. */
  readonly displayName: string;
  /** Şirketin görünen adı — kimliği değil. */
  readonly companyName: string;
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
  const base = {
    channel: "chat" as Channel,
    audit,
    completer: getCompleter(),
    auditSink: audit as InMemoryAuditSink,
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
      tenant,
      principal: identity.principal,
      identitySource: "session",
      displayName: identity.displayName,
      companyName: found.name,
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
    tenant,
    identitySource: "dev-header",
    displayName: "Cebrail Karaarslan (demo)",
    companyName: DEMO_COMPANY_NAME,
    dataPlane: "demo",
    principal: createPrincipal({
      userId: "00000000-0000-0000-0000-0000000000de",
      tenantId: tenant.tenantId,
      roles: [devRole(req)],
      approvalLimit: { amount: 1_000_000, currency: "TRY" },
    }),
  };
}
