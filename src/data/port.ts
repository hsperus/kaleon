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
  /**
   * Verinin EKSİK olduğu yerler.
   *
   * Bir kaynak "3 sipariş için sevkiyat tarihi bilinmiyor" diyebilmelidir.
   * Bu bilgi port sınırında düşerse, tool'un cevabı sessizce eksik olur:
   * kullanıcı 2 riskli sipariş görür ve 3 tanesinin hiç bakılmadığını
   * asla öğrenmez. Bilinmeyeni saklamak, yanlış cevap vermekten beterdir.
   */
  readonly caveats?: readonly string[];
}

export interface StationLoad {
  readonly station: string;
  /** Kapasite tanımlı değilse null — sıfır doluluk DEĞİL. */
  readonly utilizationPct: number | null;
  readonly activeOrders: number;
  readonly holdOrders: number;
  readonly note: string;
}

/**
 * Fabrikanın anlık durumu.
 *
 * BİLİNMEYEN ALANLAR `null`, SIFIR DEĞİL.
 *
 * "0 makine çalışıyor" ile "makine bilgisi gelmiyor" aynı ekranda aynı
 * görünürse, fabrika durmuş sanılır veya duruş fark edilmez. İkisi de
 * pahalıdır. Sayıyı bilmediğimizde sayı UYDURMAYIZ; alan null kalır ve
 * cevap bunu söyler.
 */
export interface WipSnapshot {
  /** İş emri sayımı her zaman bilinir. */
  readonly activeWorkOrders: number;
  /** Vardiya verisi bağlı değilse null. */
  readonly staffOnShift: number | null;
  readonly staffPlanned: number | null;
  /** Makine kaydı yoksa null — "0 makine çalışıyor" demek değildir. */
  readonly machinesRunning: number | null;
  readonly machinesTotal: number | null;
  readonly stations: readonly StationLoad[];
  /** Zaman damgalı üretim onayı yoksa null. */
  readonly actualRatePerHour: number | null;
  /** İş merkezi hedefi tanımlı değilse null. */
  readonly targetRatePerHour: number | null;
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
