/**
 * İçe aktarma yazıcıları.
 *
 * HEPSİ IDEMPOTENT. Kullanıcılar dosyayı iki kez yükler: bağlantı koptu
 * sanır, "acaba oldu mu" der, meslektaşı da yükler. İkinci yüklemede
 * mükerrer kayıt oluşan bir sistem, ilk aydan sonra temizlenemez.
 *
 * HEPSİ SATIR SATIR HATA TOPLAR. Bir satırın patlaması dosyayı durdurmaz;
 * 4000 satırın 3999'u yazılabiliyorsa yazılmalı, hatalı olan raporlanmalı.
 * "Hepsi ya da hiçbiri" kulağa güvenli gelir ama pratikte kullanıcıyı tek
 * hücre için her şeyi yeniden yüklemeye zorlar.
 *
 * REFERANS ÇÖZÜMLEME ÖNEMLİDİR. Puantaj dosyası personel KODU taşır,
 * sipariş dosyası müşteri UNVANI taşır. Bunlar sistemdeki kayda
 * bağlanamıyorsa satır reddedilir — uydurma bir personel veya cari
 * AÇILMAZ. Yoksa her hatalı dosya ana veriyi çöple doldurur.
 */

import type { TenantDb } from "./client.js";
import { normalizeName } from "../modules/master-data/normalize.js";
import { resolvePartner } from "../modules/master-data/resolver.js";
import { PrismaMasterDataSource } from "./master-data-source.js";
import type {
  AttendanceRow,
  BankBalanceRow,
  EmployeeRow,
  PartnerRow,
  SalesOrderRow,
} from "../modules/import/objects.js";

export interface ImportOutcome {
  readonly created: number;
  readonly updated: number;
  readonly skipped: number;
  readonly failures: readonly { readonly ref: string; readonly message: string }[];
}

export interface Classification {
  readonly toCreate: number;
  readonly toUpdate: number;
}

/** Bir nesne için yazma sözleşmesi. */
export interface Importer<T> {
  classify(rows: readonly T[]): Promise<Classification>;
  commit(rows: readonly T[]): Promise<ImportOutcome>;
}

const EMPTY: ImportOutcome = { created: 0, updated: 0, skipped: 0, failures: [] };

/** Ortak sayaç toplayıcı — her yazıcıda aynı döngüyü tekrar yazmamak için. */
async function runRows<T>(
  rows: readonly T[],
  refOf: (row: T) => string,
  handle: (row: T) => Promise<"created" | "updated" | "skipped">,
): Promise<ImportOutcome> {
  let created = 0;
  let updated = 0;
  let skipped = 0;
  const failures: { ref: string; message: string }[] = [];

  for (const row of rows) {
    try {
      const result = await handle(row);
      if (result === "created") created++;
      else if (result === "updated") updated++;
      else skipped++;
    } catch (e) {
      failures.push({ ref: refOf(row), message: (e as Error).message });
    }
  }
  return { created, updated, skipped, failures };
}

// ─────────────────────────── Cari ───────────────────────────

export class PartnerImporter implements Importer<PartnerRow> {
  constructor(private readonly db: TenantDb) {}

  /** Vergi numarası ÖNCE, cari kodu sonra — aynı firma iki kart açmasın. */
  async #find(row: PartnerRow): Promise<{ id: string } | null> {
    if (row.taxId) {
      const byTax = await this.db.partner.findFirst({
        where: { taxIds: { some: { value: row.taxId.value } } },
        select: { id: true },
      });
      if (byTax) return byTax;
    }
    return this.db.partner.findUnique({ where: { code: row.code }, select: { id: true } });
  }

  async classify(rows: readonly PartnerRow[]): Promise<Classification> {
    let toUpdate = 0;
    for (const row of rows) if (await this.#find(row)) toUpdate++;
    return { toCreate: rows.length - toUpdate, toUpdate };
  }

  async commit(rows: readonly PartnerRow[]): Promise<ImportOutcome> {
    return runRows(rows, (r) => r.code, async (row) => {
      const existing = await this.#find(row);
      if (!existing) {
        await this.db.partner.create({
          data: {
            code: row.code,
            legalName: row.legalName,
            normalized: row.normalized,
            isSupplier: row.isSupplier,
            isCustomer: row.isCustomer,
            ...(row.taxId ? { taxIds: { create: [{ kind: row.taxId.kind, value: row.taxId.value }] } } : {}),
            ...(row.externalRef
              ? { externalRefs: { create: [{ system: row.externalRef.system, externalId: row.externalRef.externalId }] } }
              : {}),
          },
        });
        return "created";
      }

      const current = await this.db.partner.findUniqueOrThrow({
        where: { id: existing.id },
        select: { legalName: true, isSupplier: true, isCustomer: true },
      });
      let changed = false;

      if (row.legalName !== current.legalName) {
        // Eski unvan alias olarak saklanır: eski belgelerdeki isim hâlâ bu
        // firmaya çözülebilmeli. Kaynak `automatic` — bu bir tahmin değil,
        // müşterinin kendi ana verisinden gelen kayıtlı bir olgu.
        await this.db.partnerAlias.upsert({
          where: {
            partnerId_normalized: {
              partnerId: existing.id,
              normalized: normalizeName(current.legalName).core,
            },
          },
          create: {
            partnerId: existing.id,
            alias: current.legalName,
            normalized: normalizeName(current.legalName).core,
            source: "automatic",
            confidence: 0.93,
          },
          update: {},
        });
        await this.db.partner.update({
          where: { id: existing.id },
          data: { legalName: row.legalName, normalized: row.normalized },
        });
        changed = true;
      }

      // Tür bayrakları yalnızca EKLENİR: bir cari hem müşteri hem tedarikçi
      // olabilir; eksik sütunlu bir dosya diğerini silmemeli.
      if ((row.isSupplier && !current.isSupplier) || (row.isCustomer && !current.isCustomer)) {
        await this.db.partner.update({
          where: { id: existing.id },
          data: {
            isSupplier: current.isSupplier || row.isSupplier,
            isCustomer: current.isCustomer || row.isCustomer,
          },
        });
        changed = true;
      }

      if (row.taxId) {
        const has = await this.db.partnerTaxId.findFirst({
          where: { partnerId: existing.id, value: row.taxId.value },
          select: { id: true },
        });
        if (!has) {
          await this.db.partnerTaxId.create({
            data: { partnerId: existing.id, kind: row.taxId.kind, value: row.taxId.value },
          });
          changed = true;
        }
      }

      return changed ? "updated" : "skipped";
    });
  }
}

// ────────────────────────── Personel ──────────────────────────

export class EmployeeImporter implements Importer<EmployeeRow> {
  constructor(private readonly db: TenantDb) {}

  async classify(rows: readonly EmployeeRow[]): Promise<Classification> {
    const codes = rows.map((r) => r.code);
    const existing = await this.db.employee.count({ where: { code: { in: codes } } });
    return { toCreate: rows.length - existing, toUpdate: existing };
  }

  async commit(rows: readonly EmployeeRow[]): Promise<ImportOutcome> {
    return runRows(rows, (r) => r.code, async (row) => {
      const found = await this.db.employee.findUnique({ where: { code: row.code } });
      const data = {
        fullName: row.fullName,
        normalized: row.normalized,
        department: row.department,
        position: row.position,
        hiredAt: new Date(row.hiredAt),
        // Maaş dosyada yoksa mevcut değer SİLİNMEZ: eksik sütunlu bir dosya
        // ücret bilgisini uçurmamalı.
        ...(row.grossSalary !== null ? { grossSalary: row.grossSalary } : {}),
      };
      if (!found) {
        await this.db.employee.create({ data: { code: row.code, ...data } });
        return "created";
      }
      await this.db.employee.update({ where: { code: row.code }, data });
      return "updated";
    });
  }
}

// ────────────────────────── Banka ──────────────────────────

export class BankImporter implements Importer<BankBalanceRow> {
  constructor(private readonly db: TenantDb) {}

  async classify(rows: readonly BankBalanceRow[]): Promise<Classification> {
    let toUpdate = 0;
    for (const row of rows) {
      const acc = await this.db.bankAccount.findUnique({
        where: { externalId_currency: { externalId: row.externalId, currency: row.currency } },
        select: { id: true },
      });
      if (!acc) continue;
      const snap = await this.db.bankBalanceSnapshot.findUnique({
        where: { accountId_asOf: { accountId: acc.id, asOf: new Date(row.asOf) } },
        select: { id: true },
      });
      if (snap) toUpdate++;
    }
    return { toCreate: rows.length - toUpdate, toUpdate };
  }

  async commit(rows: readonly BankBalanceRow[]): Promise<ImportOutcome> {
    return runRows(rows, (r) => `${r.bank}/${r.externalId}`, async (row) => {
      const account = await this.db.bankAccount.upsert({
        where: { externalId_currency: { externalId: row.externalId, currency: row.currency } },
        create: {
          bank: row.bank,
          externalId: row.externalId,
          currency: row.currency,
          iban: row.iban,
          isActive: true,
        },
        update: { bank: row.bank, ...(row.iban ? { iban: row.iban } : {}), isActive: true },
      });

      const asOf = new Date(row.asOf);
      const existing = await this.db.bankBalanceSnapshot.findUnique({
        where: { accountId_asOf: { accountId: account.id, asOf } },
        select: { id: true },
      });

      if (existing) {
        // AYNI AN İÇİN GELEN BAKİYE ÜZERİNE YAZILMAZ. Bankanın belirli bir
        // andaki beyanı tektir; iki farklı değer geldiyse hangisinin doğru
        // olduğu bilinemez. Sessizce güncellemek geçmişi tahrif eder.
        return "skipped";
      }

      await this.db.bankBalanceSnapshot.create({
        data: { accountId: account.id, asOf, available: row.available, blocked: row.blocked },
      });
      return "created";
    });
  }
}

// ────────────────────────── Puantaj ──────────────────────────

export class AttendanceImporter implements Importer<AttendanceRow> {
  constructor(private readonly db: TenantDb) {}

  async #employeeId(code: string): Promise<string | null> {
    const e = await this.db.employee.findUnique({ where: { code }, select: { id: true } });
    return e?.id ?? null;
  }

  async classify(rows: readonly AttendanceRow[]): Promise<Classification> {
    let toUpdate = 0;
    for (const row of rows) {
      const id = await this.#employeeId(row.employeeCode);
      if (!id) continue;
      const d = await this.db.attendanceDay.findUnique({
        where: { employeeId_workDate: { employeeId: id, workDate: new Date(row.workDate) } },
        select: { id: true },
      });
      if (d) toUpdate++;
    }
    return { toCreate: rows.length - toUpdate, toUpdate };
  }

  async commit(rows: readonly AttendanceRow[]): Promise<ImportOutcome> {
    return runRows(rows, (r) => `${r.employeeCode} ${r.workDate}`, async (row) => {
      const employeeId = await this.#employeeId(row.employeeCode);
      if (!employeeId) {
        // PERSONEL UYDURULMAZ. Puantaj dosyasından personel kartı açmak,
        // yazım hatası olan her kodu yeni bir çalışan yapardı.
        throw new Error(
          `${row.employeeCode} kodlu personel sistemde yok. Önce personel listesini aktarın.`,
        );
      }
      const workDate = new Date(row.workDate);
      const data = {
        workedMinutes: row.workedMinutes,
        plannedMinutes: row.plannedMinutes,
        isWeekend: row.isWeekend,
        isHoliday: row.isHoliday,
        // Onay bilgisi yalnızca EKLENİR: dosyada onay sütunu yoksa mevcut
        // onay kaldırılmaz. Onayı düşürmek yönetici kararıdır, dosya değil.
        ...(row.approved ? { approvedAt: new Date() } : {}),
      };

      const existing = await this.db.attendanceDay.findUnique({
        where: { employeeId_workDate: { employeeId, workDate } },
        select: { id: true },
      });
      if (existing) {
        await this.db.attendanceDay.update({ where: { id: existing.id }, data });
        return "updated";
      }
      await this.db.attendanceDay.create({ data: { employeeId, workDate, ...data } });
      return "created";
    });
  }
}

// ────────────────────── Satış siparişi ──────────────────────

export class SalesOrderImporter implements Importer<SalesOrderRow> {
  readonly #master: PrismaMasterDataSource;

  constructor(private readonly db: TenantDb) {
    this.#master = new PrismaMasterDataSource(db);
  }

  /**
   * Müşteri unvanını cari kaydına çözer.
   *
   * Entity resolution motorunun aynısı kullanılır — dosyada "Volvo" yazan
   * satır, sistemdeki "Volvo Group Sweden AB" kaydına bağlanmalı. Çözülemezse
   * satır REDDEDİLİR; uydurma cari açmak ana veriyi çöple doldurur.
   */
  async #customerId(ref: string): Promise<string | null> {
    const { rows } = await this.#master.partnerCandidates("", { name: ref, taxId: null });
    const result = resolvePartner({ name: ref, taxId: null, externalRef: null }, rows);
    return result.status === "resolved" ? result.match.partnerId : null;
  }

  async classify(rows: readonly SalesOrderRow[]): Promise<Classification> {
    const nos = rows.map((r) => r.orderNo);
    const existing = await this.db.salesOrder.count({ where: { orderNo: { in: nos } } });
    return { toCreate: rows.length - existing, toUpdate: existing };
  }

  async commit(rows: readonly SalesOrderRow[]): Promise<ImportOutcome> {
    return runRows(rows, (r) => r.orderNo, async (row) => {
      const partnerId = await this.#customerId(row.customerRef);
      if (!partnerId) {
        throw new Error(
          `"${row.customerRef}" müşterisi tek bir cariye çözülemedi. Önce cari listesini aktarın veya unvanı netleştirin.`,
        );
      }

      const data = {
        partnerId,
        committedDate: new Date(row.committedDate),
        penaltyPerDay: row.penaltyPerDay,
        penaltyCap: row.penaltyCap,
        currency: row.currency,
      };

      const existing = await this.db.salesOrder.findUnique({
        where: { orderNo: row.orderNo },
        select: { id: true },
      });
      if (existing) {
        await this.db.salesOrder.update({ where: { id: existing.id }, data });
        return "updated";
      }
      await this.db.salesOrder.create({ data: { orderNo: row.orderNo, ...data } });
      return "created";
    });
  }
}

/** Nesne kimliğine göre doğru yazıcıyı üretir. */
export function importerFor(objectId: string, db: TenantDb): Importer<never> {
  switch (objectId) {
    case "partners":
      return new PartnerImporter(db) as unknown as Importer<never>;
    case "employees":
      return new EmployeeImporter(db) as unknown as Importer<never>;
    case "bank":
      return new BankImporter(db) as unknown as Importer<never>;
    case "attendance":
      return new AttendanceImporter(db) as unknown as Importer<never>;
    case "sales_orders":
      return new SalesOrderImporter(db) as unknown as Importer<never>;
    default:
      // Tanımsız nesne için boş yazıcı DÖNMEZ: sessizce hiçbir şey yapan
      // bir içe aktarma, "başarıyla aktarıldı" deyip veriyi kaybettirir.
      throw new Error(`Bilinmeyen içe aktarma nesnesi: ${objectId}`);
  }
}

export { EMPTY as EMPTY_OUTCOME };
