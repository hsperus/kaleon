/**
 * Kompozisyon kökü — tüm bağımlılıkların bağlandığı tek yer.
 */

import Anthropic from "@anthropic-ai/sdk";
import { ToolRegistry } from "./kernel/registry.js";
import { importTools, type ImportDeps } from "./modules/import/tools.js";
import { InMemoryAuditSink, type AuditSink } from "./kernel/audit.js";
import { LlmGateway } from "./ai/gateway.js";
import { InMemoryLedger, type UsageLedger } from "./ai/ledger.js";
import { SYSTEM_PROMPT } from "./ai/system-prompt.js";
import { InMemoryDataSource } from "./data/memory.js";
import type { DataSource } from "./data/port.js";
import { masterDataTools } from "./modules/master-data/tools.js";
import { operationsTools } from "./modules/operations/tools.js";
import { productionTools } from "./modules/operations/production-tools.js";
import { InMemoryOperationsRepository, type OperationsRepository } from "./modules/operations/repository.js";
import { documentTools } from "./modules/documents/tools.js";
import {
  InMemoryApprovalRepository,
  InMemoryDocumentsRepository,
  type ApprovalRepository,
  type DocumentsRepository,
} from "./modules/documents/repository.js";
import { financeTools } from "./modules/finance/tools.js";
import { hrTools } from "./modules/hr/tools.js";
import type { Tool } from "./kernel/tool.js";

export interface Kaelon {
  readonly registry: ToolRegistry;
  readonly audit: AuditSink;
  readonly ledger: UsageLedger;
  readonly gateway: LlmGateway;
}

export interface Repositories {
  readonly operations?: OperationsRepository;
  readonly documents?: DocumentsRepository;
  readonly approvals?: ApprovalRepository;
  /**
   * İçe aktarma bağımlılıkları. Verilmezse içe aktarma tool'ları KAYDEDİLMEZ:
   * çağrılınca patlayan bir tool'u kataloğa koymak, modele olmayan bir
   * yetenek vaat etmektir.
   */
  readonly imports?: ImportDeps;
}

export function buildRegistry(db: DataSource, repos: Repositories = {}): ToolRegistry {
  const registry = new ToolRegistry();
  const operations = repos.operations ?? new InMemoryOperationsRepository();
  const documents = repos.documents ?? new InMemoryDocumentsRepository();
  const approvals = repos.approvals ?? new InMemoryApprovalRepository();
  const all = [
    ...masterDataTools(db),
    ...operationsTools(db),
    ...productionTools(operations),
    ...documentTools(documents, approvals),
    ...financeTools(db),
    ...hrTools(db),
    ...(repos.imports ? importTools(repos.imports) : []),
  ];
  registry.register(...(all as unknown as Tool<never, unknown>[]));
  return registry;
}

export function createKaelon(options?: {
  db?: DataSource;
  repos?: Repositories;
  audit?: AuditSink;
  ledger?: UsageLedger;
  client?: Anthropic;
}): Kaelon {
  const db = options?.db ?? new InMemoryDataSource();
  const audit = options?.audit ?? new InMemoryAuditSink();
  const ledger = options?.ledger ?? new InMemoryLedger();
  const client = options?.client ?? new Anthropic();

  return {
    registry: buildRegistry(db, options?.repos ?? {}),
    audit,
    ledger,
    gateway: new LlmGateway({ client, ledger, systemPrompt: SYSTEM_PROMPT }),
  };
}
