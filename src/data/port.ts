/**
 * Veri portu (hexagonal sınır).
 *
 * Tool'lar Prisma'yı değil bu arayüzü bilir. Böylece:
 *  - çekirdek testleri veritabanı olmadan koşar,
 *  - Prisma adaptörü sonradan mekanik olarak takılır,
 *  - schema-per-tenant yönlendirmesi tek yerde kalır.
 *
 * Her okuma metodu, verinin tazeliğini birlikte döndürür — "son senkronizasyon"
 * bilgisi cevabın zorunlu parçası olduğu için veri katmanından gelmelidir.
 */

export interface Freshness {
  readonly syncedAt: string;
  readonly recordCount: number;
}

export interface WithFreshness<T> {
  readonly rows: T;
  readonly freshness: Freshness;
}

export interface StationLoad {
  readonly station: string;
  readonly utilizationPct: number;
  readonly activeOrders: number;
  readonly holdOrders: number;
  readonly note: string;
}

export interface WipSnapshot {
  readonly activeWorkOrders: number;
  readonly staffOnShift: number;
  readonly staffPlanned: number;
  readonly machinesRunning: number;
  readonly machinesTotal: number;
  readonly stations: readonly StationLoad[];
  readonly actualRatePerHour: number;
  readonly targetRatePerHour: number;
}

export interface ShipmentRisk {
  readonly salesOrder: string;
  readonly customer: string;
  readonly committedDate: string;
  readonly estimatedDate: string;
  readonly slipDays: number;
  readonly penaltyRiskTry: number;
}

export interface BankBalance {
  readonly bank: string;
  readonly currency: string;
  readonly available: number;
  readonly blocked: number;
}

export interface OvertimeRecord {
  readonly employeeId: string;
  readonly employeeName: string;
  readonly department: string;
  readonly weekdayMinutes: number;
  readonly weekendMinutes: number;
  readonly pendingApprovalMinutes: number;
  readonly grossSalaryTry: number;
}

export interface DataSource {
  wipSnapshot(tenantId: string): Promise<WithFreshness<WipSnapshot>>;
  shipmentRisks(tenantId: string, week: number): Promise<WithFreshness<readonly ShipmentRisk[]>>;
  bankBalances(tenantId: string, currency: string | null): Promise<WithFreshness<readonly BankBalance[]>>;
  overtime(
    tenantId: string,
    args: { employeeQuery: string | null; department: string | null; period: string },
  ): Promise<WithFreshness<readonly OvertimeRecord[]>>;
  /**
   * Entity resolution adayları. Gerçek adaptörde indeksli ön eleme yapar
   * (normalized prefix, token GIN indeksi); motor saf kalır.
   */
  partnerCandidates(
    tenantId: string,
    hint: PartnerHint,
  ): Promise<WithFreshness<readonly PartnerCandidateRow[]>>;
}

/**
 * Aday getirme ipucu.
 *
 * `externalRef` ÖNEMLİDİR: e-faturalar çoğu zaman ne düzgün bir unvanla ne
 * de vergi numarasıyla gelir — entegratörün cari kodunu taşır. Bu kanal
 * olmadan, yalnızca cari koduyla gelen bir belge hiçbir adaya ulaşamaz ve
 * çözümleyici "yeni firma" der. Aynı firma her fatura için yeniden açılırdı.
 */
export interface PartnerHint {
  readonly name: string | null;
  readonly taxId: string | null;
  readonly externalRef?: { readonly system: string; readonly externalId: string } | null;
}

/** Entity resolution için ön elemeli aday getirme. */
export interface PartnerCandidateRow {
  readonly partnerId: string;
  readonly legalName: string;
  readonly taxIds: readonly { kind: string; value: string; valid: boolean }[];
  readonly externalRefs: readonly { system: string; externalId: string }[];
  readonly aliases: readonly { alias: string; source: "observed" | "confirmed" | "automatic" }[];
  readonly mergedInto?: string | null;
}
