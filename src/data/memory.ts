/**
 * Bellekte çalışan veri kaynağı — test ve demo içindir.
 * Veriler Orthaus pilot senaryosundan (treyler üretimi) türetilmiştir.
 *
 * Prisma adaptörü geldiğinde bu dosya yalnızca testlerde kalır.
 */

import type {
  BankBalance,
  DataSource,
  OvertimeRecord,
  ShipmentRisk,
  WipSnapshot,
  WithFreshness,
} from "./port.js";

const SYNCED = "2026-05-16T07:38:00.000Z";

const WIP: WipSnapshot = {
  activeWorkOrders: 142,
  staffOnShift: 87,
  staffPlanned: 94,
  machinesRunning: 31,
  machinesTotal: 38,
  actualRatePerHour: 29,
  targetRatePerHour: 38,
  stations: [
    { station: "Kesim", utilizationPct: 89, activeOrders: 12, holdOrders: 0, note: "Kapasitenin sınırına yakın" },
    { station: "Kaynak", utilizationPct: 64, activeOrders: 8, holdOrders: 4, note: "4 iş emri kalite hold'da" },
    { station: "Boya", utilizationPct: 96, activeOrders: 0, holdOrders: 6, note: "Darboğaz — 6 iş emri sırada" },
    { station: "Montaj", utilizationPct: 41, activeOrders: 6, holdOrders: 0, note: "Boya çıkışı bekleniyor" },
  ],
};

const SHIPMENTS: readonly ShipmentRisk[] = [
  { salesOrder: "SO-2026-0418", customer: "Volvo", committedDate: "2026-05-12", estimatedDate: "2026-05-16", slipDays: 4, penaltyRiskTry: 78_000 },
  { salesOrder: "SO-2026-0427", customer: "Daimler", committedDate: "2026-05-13", estimatedDate: "2026-05-18", slipDays: 5, penaltyRiskTry: 52_000 },
  { salesOrder: "SO-2026-0431", customer: "MAN", committedDate: "2026-05-14", estimatedDate: "2026-05-17", slipDays: 3, penaltyRiskTry: 26_000 },
];

const BANKS: readonly BankBalance[] = [
  { bank: "Garanti BBVA", currency: "TRY", available: 12_400_000, blocked: 0 },
  { bank: "İş Bankası", currency: "TRY", available: 8_600_000, blocked: 0 },
  { bank: "Yapı Kredi", currency: "TRY", available: 4_200_000, blocked: 0 },
  { bank: "Garanti BBVA", currency: "EUR", available: 198_400, blocked: 0 },
  { bank: "İş Bankası", currency: "EUR", available: 126_050, blocked: 16_650 },
  { bank: "Yapı Kredi", currency: "EUR", available: 86_750, blocked: 0 },
];

const OVERTIME: readonly OvertimeRecord[] = [
  { employeeId: "E-1042", employeeName: "Hasan Turan", department: "Kaynak", weekdayMinutes: 855, weekendMinutes: 270, pendingApprovalMinutes: 360, grossSalaryTry: 62_000 },
  { employeeId: "E-1180", employeeName: "Ayşe Demir", department: "Montaj", weekdayMinutes: 420, weekendMinutes: 0, pendingApprovalMinutes: 0, grossSalaryTry: 58_000 },
];

function fresh<T>(rows: T, recordCount: number): WithFreshness<T> {
  return { rows, freshness: { syncedAt: SYNCED, recordCount } };
}

export class InMemoryDataSource implements DataSource {
  async wipSnapshot(): Promise<WithFreshness<WipSnapshot>> {
    return fresh(WIP, WIP.stations.length);
  }

  async shipmentRisks(): Promise<WithFreshness<readonly ShipmentRisk[]>> {
    return fresh(SHIPMENTS, SHIPMENTS.length);
  }

  async bankBalances(
    _tenantId: string,
    currency: string | null,
  ): Promise<WithFreshness<readonly BankBalance[]>> {
    const rows = currency ? BANKS.filter((b) => b.currency === currency) : BANKS;
    return fresh(rows, rows.length);
  }

  async overtime(
    _tenantId: string,
    args: { employeeQuery: string | null; department: string | null; period: string },
  ): Promise<WithFreshness<readonly OvertimeRecord[]>> {
    let rows = OVERTIME;
    if (args.employeeQuery) {
      const q = args.employeeQuery.toLocaleLowerCase("tr");
      rows = rows.filter((r) => r.employeeName.toLocaleLowerCase("tr").includes(q));
    }
    if (args.department) rows = rows.filter((r) => r.department === args.department);
    return fresh(rows, rows.length);
  }

  async partnerCandidates(): Promise<
    WithFreshness<readonly import("./port.js").PartnerCandidateRow[]>
  > {
    return fresh(PARTNERS, PARTNERS.length);
  }
}

const PARTNERS: readonly import("./port.js").PartnerCandidateRow[] = [
  {
    partnerId: "p-burcelik",
    legalName: "Burçelik Bursa Çelik Döküm Sanayi A.Ş.",
    taxIds: [{ kind: "vkn", value: "1234567890", valid: true }],
    externalRefs: [{ system: "uyumsoft", externalId: "SUP-00432" }],
    aliases: [
      { alias: "Burçelik", source: "confirmed" },
      { alias: "BURÇELİK A.Ş.", source: "confirmed" },
    ],
  },
  {
    partnerId: "p-volvo",
    legalName: "Volvo Group Sweden AB",
    taxIds: [],
    externalRefs: [{ system: "uyumsoft", externalId: "CUS-04521" }],
    aliases: [{ alias: "Volvo", source: "confirmed" }],
  },
];
