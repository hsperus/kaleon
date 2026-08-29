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

export const DEMO_TENANT: TenantContext = {
  tenantId: "demo",
  schema: "tenant_demo",
  locale: "tr-TR",
  baseCurrency: "TRY",
};

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

const db = new InMemoryDataSource();
const operations = new InMemoryOperationsRepository({ bomRevisions: { "FR-22": "R3" } });
const documents = new InMemoryDocumentsRepository();
const approvals = new InMemoryApprovalRepository();
const audit: AuditSink = new InMemoryAuditSink();
const ledger = new InMemoryLedger();

void operations.saveWorkOrder(
  DEMO_TENANT.tenantId,
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

const registry: ToolRegistry = buildRegistry(db, { operations, documents, approvals });

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
  /** Kimliğin nereden geldiği — arayüzde ve denetim kaydında görünür. */
  readonly identitySource: "session" | "dev-header";
  /** Verinin nereden geldiği. "demo" iken arayüz bunu açıkça yazar. */
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
  const shared = {
    tenant: DEMO_TENANT,
    channel: "chat" as Channel,
    registry,
    audit,
    completer: getCompleter(),
    auditSink: audit as InMemoryAuditSink,
    dataPlane: "demo" as const,
  };

  // 1. Gerçek oturum
  const identity = await principalFromSession(req);
  if (identity) {
    return { ...shared, principal: identity.principal, identitySource: "session" };
  }

  // 2. Geliştirme rolü — üretimde bu satıra gelinmez.
  if (!DEV) throw new UnauthenticatedError();

  return {
    ...shared,
    identitySource: "dev-header",
    principal: createPrincipal({
      userId: "00000000-0000-0000-0000-0000000000de",
      tenantId: DEMO_TENANT.tenantId,
      roles: [devRole(req)],
      approvalLimit: { amount: 1_000_000, currency: "TRY" },
    }),
  };
}
