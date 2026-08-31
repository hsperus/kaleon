/**
 * Kompozisyon kökü — tüm bağımlılıkların bağlandığı tek yer.
 */

import Anthropic from "@anthropic-ai/sdk";
import { ToolRegistry } from "./kernel/registry.js";
import { importTools, type ImportDeps } from "./modules/import/tools.js";
import { itemTools, type ItemRepository } from "./modules/master-data/item-tools.js";
import { salesTools } from "./modules/sales/sales-tools.js";
import { valuationTools } from "./modules/inventory/valuation-tools.js";
import { periodTools } from "./modules/finance/period-tools.js";
import { revaluationTools } from "./modules/finance/revaluation-tools.js";
import { rosterTools } from "./modules/hr/roster-tools.js";
import { discoveryTools } from "./modules/discovery/tools.js";
import { masterDataCrudTools } from "./modules/master-data/crud-tools.js";
import { batchTools } from "./modules/inventory/batch-tools.js";
import { procurementTools } from "./modules/procurement/procurement-tools.js";
import { leaveTools } from "./modules/hr/leave-tools.js";
import { changeTools } from "./modules/master-data/change-tools.js";
import { accountingTools } from "./modules/accounting/accounting-tools.js";
import { stockCountTools } from "./modules/inventory/stock-count-tools.js";
import { mrpTools } from "./modules/planning/mrp-tools.js";
import { assetTools } from "./modules/assets/asset-tools.js";
import { creditNoteTools } from "./modules/sales/credit-note-tools.js";
import { payrollTools } from "./modules/payroll/payroll-tools.js";
import { watchTools } from "./modules/briefing/watch-tools.js";
import type { WatchRepository } from "./db/watch-repository.js";
import type { PayrollRepository } from "./db/payroll-repository.js";
import type { CreditNoteRepository } from "./db/credit-note-repository.js";
import type { AssetRepository } from "./db/asset-repository.js";
import { einvoiceTools } from "./modules/einvoice/einvoice-tools.js";
import { costingTools } from "./modules/operations/costing-tools.js";
import { quotationTools } from "./modules/sales/quotation-tools.js";
import { maintenanceTools } from "./modules/maintenance/maintenance-tools.js";
import { flowTools } from "./modules/documents/flow-tools.js";
import { organizationTools } from "./modules/master-data/organization-tools.js";
import { capacityTools } from "./modules/planning/capacity-tools.js";
import { serialTools } from "./modules/inventory/serial-tools.js";
import type { SerialRepository } from "./db/serial-repository.js";
import type { CapacityRepository } from "./db/capacity-repository.js";
import type { OrganizationRepository } from "./db/organization-repository.js";
import type { DocumentFlowRepository } from "./db/document-flow-repository.js";
import type { MaintenanceRepository } from "./db/maintenance-repository.js";
import type { QuotationRepository } from "./db/quotation-repository.js";
import type { CostingRepository } from "./db/costing-repository.js";
import type { EInvoiceRepository } from "./db/einvoice-repository.js";
import type { MrpRepository } from "./db/mrp-repository.js";
import type { StockCountRepository } from "./db/stock-count-repository.js";
import type { JournalRepository } from "./db/journal-repository.js";
import type { ChangeLogRepository } from "./db/change-log.js";
import type { LeaveRepository } from "./db/leave-repository.js";
import type { ProcurementRepository } from "./db/procurement-repository.js";
import type { BatchRepository } from "./db/batch-repository.js";
import type { PeriodRepository } from "./db/period-repository.js";
import type { RevaluationRepository } from "./db/revaluation-repository.js";
import type { TenantDb } from "./db/client.js";
import type { ValuationRepository } from "./db/valuation-repository.js";
import type { SalesRepository } from "./db/sales-repository.js";
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
  /** Malzeme ana verisi. Verilmezse malzeme tool'ları KAYDEDİLMEZ —
   *  çağrılınca patlayan bir tool'u kataloğa koymak, modele olmayan bir
   *  yetenek vaat etmektir. */
  readonly items?: ItemRepository;
  /** Satış zinciri: sipariş → sevkiyat → fatura. Aynı gerekçeyle opsiyonel. */
  readonly sales?: SalesRepository;
  /** Stok değerleme ve döviz kuru. */
  readonly valuation?: ValuationRepository;
  /** Muhasebe dönemi ve dönem kapama. */
  readonly periods?: PeriodRepository;
  readonly revaluation?: RevaluationRepository;
  /** Doğrudan tenant istemcisi — kadro gibi tek tablo sorguları için. */
  readonly tenantDb?: TenantDb;
  /** Parti izleme ve şecere. */
  readonly batches?: BatchRepository;
  /** Satın alma talebi ve ödeme. */
  readonly procurement?: ProcurementRepository;
  /** İzin ve vardiya. */
  readonly leave?: LeaveRepository;
  /** Ana veri değişiklik belgesi. */
  readonly changes?: ChangeLogRepository;
  /** Yevmiye defteri, mizan ve cari ekstre. */
  readonly journal?: JournalRepository;
  /** Sabit kıymet ve amortisman. */
  readonly assets?: AssetRepository;
  /** Satış iadesi ve dekontlar. */
  readonly creditNotes?: CreditNoteRepository;
  /** Bordro. */
  readonly payroll?: PayrollRepository;
  /** Kullanıcı tanımlı izlemeler. */
  readonly watches?: WatchRepository;
  /**
   * Denetim kaydı — izleme tool'ları kurulum sırasında tool
   * çalıştırdığı için gerekir. Verilmezse izleme tool'ları KAYDEDİLMEZ:
   * kaydı tutulmayan bir çalıştırma yolu açmaktansa yeteneği hiç
   * sunmamak doğrudur.
   */
  readonly audit?: AuditSink;
  /** Stok sayımı. */
  readonly stockCounts?: StockCountRepository;
  /** Malzeme ihtiyaç planlaması. */
  readonly mrp?: MrpRepository;
  /** e-Fatura / e-Arşiv belgesi üretimi. */
  readonly einvoice?: EInvoiceRepository;
  /** İş emri maliyeti ve sapma analizi. */
  readonly costing?: CostingRepository;
  /** Teklif zinciri ve fiyat koşulları. */
  readonly quotations?: QuotationRepository;
  /** Bakım planı, arıza ve bakım iş emri. */
  readonly maintenance?: MaintenanceRepository;
  /** Belge zinciri görünümü. */
  readonly flow?: DocumentFlowRepository;
  /** Tesis / depo / depo yeri hiyerarşisi. */
  readonly organization?: OrganizationRepository;
  /** Kapasite planlama. */
  readonly capacity?: CapacityRepository;
  /** Seri numarası izleme ve garanti. */
  readonly serials?: SerialRepository;
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
    ...(repos.items ? itemTools(repos.items) : []),
    ...(repos.sales ? salesTools(repos.sales) : []),
    ...(repos.valuation ? valuationTools(repos.valuation) : []),
    ...(repos.periods ? periodTools(repos.periods) : []),
    // KADRO LİSTESİ ZİNCİRİN İLK HALKASI. Kişi sorguları personel kodu
    // istiyor; kodu bilmek için önce listeyi görmek gerekiyor.
    ...(repos.tenantDb ? rosterTools(repos.tenantDb) : []),
    /*
     * KEŞİF TOOL'LARI. Ayrıntı tool'ları belge numarası istiyor ama o
     * numarayı bulmanın yolu yoktu: "sayımda fark var mı" sorusuna
     * ajan "belge numarasını verir misiniz" diyordu.
     */
    ...(repos.tenantDb ? discoveryTools(repos.tenantDb) : []),
    /*
     * ANA VERİ OLUŞTURMA VE GÜNCELLEME. 151 tool içinde tek bir
     * `update_*` yoktu: kullanıcı yeni müşteri ekleyemiyor, adres
     * düzeltemiyor, ücret değiştiremiyordu.
     */
    ...(repos.tenantDb ? masterDataCrudTools(repos.tenantDb) : []),
    // Kur değerlemesi HEM defteri HEM kur tablosunu okur; ikisi de
    // yoksa tool hiç kurulmaz — yarım bir değerleme yanlış sayı üretir.
    ...(repos.revaluation && repos.valuation
      ? revaluationTools(repos.revaluation, repos.valuation)
      : []),
    ...(repos.batches ? batchTools(repos.batches) : []),
    ...(repos.procurement ? procurementTools(repos.procurement) : []),
    ...(repos.leave ? leaveTools(repos.leave) : []),
    ...(repos.changes ? changeTools(repos.changes) : []),
    ...(repos.journal ? accountingTools(repos.journal) : []),
    ...(repos.assets ? assetTools(repos.assets) : []),
    ...(repos.creditNotes ? creditNoteTools(repos.creditNotes) : []),
    // İzleme tool'ları registry'nin KENDİSİNİ görür: kurulacak izlemenin
    // hedef tool'u var mı ve okuma tool'u mu, oradan doğrulanır.
    ...(repos.watches && repos.audit
      ? watchTools(repos.watches, () => registry, () => repos.audit!)
      : []),
    ...(repos.payroll ? payrollTools(repos.payroll) : []),
    ...(repos.stockCounts ? stockCountTools(repos.stockCounts) : []),
    ...(repos.mrp ? mrpTools(repos.mrp) : []),
    ...(repos.einvoice ? einvoiceTools(repos.einvoice) : []),
    ...(repos.costing ? costingTools(repos.costing) : []),
    ...(repos.quotations ? quotationTools(repos.quotations) : []),
    ...(repos.maintenance ? maintenanceTools(repos.maintenance) : []),
    ...(repos.flow ? flowTools(repos.flow) : []),
    ...(repos.organization ? organizationTools(repos.organization) : []),
    ...(repos.capacity ? capacityTools(repos.capacity) : []),
    ...(repos.serials ? serialTools(repos.serials) : []),
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
