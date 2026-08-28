/**
 * Kompozisyon kökü — tüm bağımlılıkların bağlandığı tek yer.
 */

import Anthropic from "@anthropic-ai/sdk";
import { ToolRegistry } from "./kernel/registry.js";
import { InMemoryAuditSink, type AuditSink } from "./kernel/audit.js";
import { LlmGateway } from "./ai/gateway.js";
import { InMemoryLedger, type UsageLedger } from "./ai/ledger.js";
import { SYSTEM_PROMPT } from "./ai/system-prompt.js";
import { InMemoryDataSource } from "./data/memory.js";
import type { DataSource } from "./data/port.js";
import { operationsTools } from "./modules/operations/tools.js";
import { financeTools } from "./modules/finance/tools.js";
import { hrTools } from "./modules/hr/tools.js";
import type { Tool } from "./kernel/tool.js";

export interface Kaelon {
  readonly registry: ToolRegistry;
  readonly audit: AuditSink;
  readonly ledger: UsageLedger;
  readonly gateway: LlmGateway;
}

export function buildRegistry(db: DataSource): ToolRegistry {
  const registry = new ToolRegistry();
  const all = [...operationsTools(db), ...financeTools(db), ...hrTools(db)];
  registry.register(...(all as unknown as Tool<never, unknown>[]));
  return registry;
}

export function createKaelon(options?: {
  db?: DataSource;
  audit?: AuditSink;
  ledger?: UsageLedger;
  client?: Anthropic;
}): Kaelon {
  const db = options?.db ?? new InMemoryDataSource();
  const audit = options?.audit ?? new InMemoryAuditSink();
  const ledger = options?.ledger ?? new InMemoryLedger();
  const client = options?.client ?? new Anthropic();

  return {
    registry: buildRegistry(db),
    audit,
    ledger,
    gateway: new LlmGateway({ client, ledger, systemPrompt: SYSTEM_PROMPT }),
  };
}
