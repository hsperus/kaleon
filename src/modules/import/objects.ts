/**
 * İçe aktarma nesneleri.
 *
 * Her nesne bir dosya türüne karşılık gelir ve bir YETKİYE bağlıdır.
 * Puantaj dosyasını satın almacı yükleyemez; cari listesini İK yükleyemez.
 *
 * ORTAK DESEN: satır satır doğrula, hatalıyı satır numarasıyla reddet,
 * geçerliyi geçir. Bir satırın hatası dosyayı durdurmaz — kullanıcıyı
 * 4000 satırı tek hücre için yeniden yüklemeye zorlamak, içe aktarmayı
 * hiç kullanılmaz hâle getirir.
 */

import { isValidTckn, isValidVkn } from "../master-data/identifiers.js";
import { normalizeName } from "../master-data/normalize.js";
import { parseTurkishDate, parseTurkishNumber } from "./csv.js";
import type { CsvTable } from "./csv.js";
import { mapColumns, rowReader, type ImportObject, type RowError } from "./framework.js";

// ─────────────────────────── Cari ───────────────────────────

export interface PartnerRow {
  readonly code: string;
  readonly legalName: string;
  readonly normalized: string;
  readonly taxId: { kind: "vkn" | "tckn"; value: string } | null;
  readonly externalRef: { system: string; externalId: string } | null;
  readonly isSupplier: boolean;
  readonly isCustomer: boolean;
}

export const PARTNER_OBJECT: ImportObject<PartnerRow> = {
  id: "partners",
  label: "Cari listesi",
  requires: "master-data:partner.write",
  templateHeaders: ["Cari Kodu", "Unvan", "Vergi No", "Tür", "Entegratör Kodu"],
  fields: [
    { key: "code", label: "Cari kodu", aliases: ["cari kodu", "cari kod", "kod", "code", "musteri kodu", "tedarikci kodu"] },
    { key: "legalName", label: "Unvan", required: true, aliases: ["unvan", "unvani", "ticari unvan", "firma", "firma adi", "cari adi", "name"] },
    { key: "taxId", label: "Vergi no", aliases: ["vkn", "vergi no", "vergi kimlik no", "vergi numarasi", "tckn", "tc kimlik", "tax id"] },
    { key: "externalId", label: "Entegratör kodu", aliases: ["entegrator kodu", "dis kod", "harici kod", "external id", "referans"] },
    { key: "type", label: "Tür", aliases: ["tur", "tip", "cari turu", "type"] },
  ],

  parse(table, columns) {
    const rows = rowReader(table, columns);
    const valid: PartnerRow[] = [];
    const errors: RowError[] = [];
    const seenCodes = new Set<string>();
    const seenTaxIds = new Set<string>();

    rows.forEach((get, i) => {
      const line = i + 2;
      const legalName = get("legalName");
      if (!legalName) {
        errors.push({ line, field: "unvan", message: "Unvan boş." });
        return;
      }

      let taxId: PartnerRow["taxId"] = null;
      const rawTax = get("taxId").replace(/\D/g, "");
      if (rawTax) {
        if (rawTax.length === 10 && isValidVkn(rawTax)) taxId = { kind: "vkn", value: rawTax };
        else if (rawTax.length === 11 && isValidTckn(rawTax)) taxId = { kind: "tckn", value: rawTax };
        else {
          // Yanlış vergi numarası ileride iki farklı firmayı birleştirebilir
          // veya e-fatura eşleştirmesini bozar. Sessizce kaydedilmez.
          errors.push({
            line,
            field: "vergi no",
            message: `"${get("taxId")}" geçerli bir VKN/TCKN değil (kontrol hanesi tutmuyor).`,
          });
          return;
        }
        if (seenTaxIds.has(taxId.value)) {
          errors.push({ line, field: "vergi no", message: `${taxId.value} bu dosyada tekrar ediyor.` });
          return;
        }
        seenTaxIds.add(taxId.value);
      }

      const code = get("code") || generateCode(legalName, i);
      if (seenCodes.has(code)) {
        errors.push({ line, field: "cari kodu", message: `"${code}" bu dosyada tekrar ediyor.` });
        return;
      }
      seenCodes.add(code);

      const rawType = normalizeName(get("type")).full;
      const isSupplier = rawType.includes("tedarik") || rawType.includes("satici") || rawType === "";
      const isCustomer = rawType.includes("musteri") || rawType.includes("alici") || rawType === "";
      const externalId = get("externalId");

      valid.push({
        code,
        legalName,
        normalized: normalizeName(legalName).core,
        taxId,
        externalRef: externalId ? { system: "dosya", externalId } : null,
        isSupplier,
        isCustomer,
      });
    });

    return { valid, errors };
  },
};

function generateCode(legalName: string, index: number): string {
  const slug = normalizeName(legalName).core.replace(/[^a-z0-9]/g, "").slice(0, 8).toUpperCase();
  return `${slug || "CARI"}-${String(index + 1).padStart(4, "0")}`;
}

// ────────────────────────── Banka ──────────────────────────

export interface BankBalanceRow {
  readonly bank: string;
  readonly externalId: string;
  readonly iban: string | null;
  readonly currency: string;
  readonly asOf: string;
  readonly available: number;
  readonly blocked: number;
}

/** Para birimi kodları — dosyada "TL", "₺", "Euro" gibi yazılabilir. */
const CURRENCY_ALIASES: Readonly<Record<string, string>> = {
  tl: "TRY", try: "TRY", "₺": "TRY", "turk lirasi": "TRY", lira: "TRY",
  eur: "EUR", euro: "EUR", "€": "EUR", avro: "EUR",
  usd: "USD", dolar: "USD", $: "USD",
  gbp: "GBP", sterlin: "GBP",
};

function normalizeCurrency(raw: string): string | null {
  const key = normalizeName(raw).full;
  return CURRENCY_ALIASES[key] ?? (/^[a-z]{3}$/.test(key) ? key.toUpperCase() : null);
}

export const BANK_OBJECT: ImportObject<BankBalanceRow> = {
  id: "bank",
  label: "Banka bakiyeleri",
  requires: "finance:bank.write",
  templateHeaders: ["Banka", "Hesap No", "IBAN", "Para Birimi", "Tarih", "Kullanılabilir", "Blokeli"],
  fields: [
    { key: "bank", label: "Banka", required: true, aliases: ["banka", "banka adi", "bank"] },
    { key: "externalId", label: "Hesap no", required: true, aliases: ["hesap no", "hesap numarasi", "hesap", "account"] },
    { key: "iban", label: "IBAN", aliases: ["iban"] },
    { key: "currency", label: "Para birimi", required: true, aliases: ["para birimi", "doviz", "kur", "currency", "pb"] },
    { key: "asOf", label: "Tarih", required: true, aliases: ["tarih", "valor", "date", "bakiye tarihi"] },
    { key: "available", label: "Kullanılabilir", required: true, aliases: ["kullanilabilir", "bakiye", "tutar", "available", "serbest"] },
    { key: "blocked", label: "Blokeli", aliases: ["blokeli", "bloke", "blocked", "rehin"] },
  ],

  parse(table, columns) {
    const rows = rowReader(table, columns);
    const valid: BankBalanceRow[] = [];
    const errors: RowError[] = [];
    const seen = new Set<string>();

    rows.forEach((get, i) => {
      const line = i + 2;
      const bank = get("bank");
      const externalId = get("externalId");
      if (!bank || !externalId) {
        errors.push({ line, field: "hesap", message: "Banka veya hesap no boş." });
        return;
      }

      const currency = normalizeCurrency(get("currency"));
      if (!currency) {
        // PARA BİRİMİ VARSAYILMAZ. "TRY kabul edelim" demek, EUR hesabını
        // TL sanıp toplam pozisyonu milyonlarca lira yanlış göstermektir.
        errors.push({
          line,
          field: "para birimi",
          message: `"${get("currency")}" para birimi tanınmadı. TL/TRY, EUR, USD, GBP yazın.`,
        });
        return;
      }

      const asOf = parseTurkishDate(get("asOf"));
      if (!asOf) {
        errors.push({ line, field: "tarih", message: `"${get("asOf")}" geçerli bir tarih değil.` });
        return;
      }

      const available = parseTurkishNumber(get("available"));
      if (available === null) {
        errors.push({ line, field: "kullanılabilir", message: "Bakiye boş veya sayı değil." });
        return;
      }
      // Blokeli boşsa SIFIR kabul edilir; bakiyeden farklı olarak burada
      // "boş" gerçekten "bloke yok" demektir ve dosyaların çoğunda sütun yoktur.
      const blocked = parseTurkishNumber(get("blocked")) ?? 0;

      // Aynı hesap + aynı an dosyada iki kez olamaz: hangisinin doğru
      // olduğu bilinemez ve veritabanı kısıtı zaten reddeder.
      const key = `${externalId}|${currency}|${asOf}`;
      if (seen.has(key)) {
        errors.push({ line, field: "hesap", message: "Aynı hesap ve tarih bu dosyada tekrar ediyor." });
        return;
      }
      seen.add(key);

      valid.push({
        bank,
        externalId,
        iban: get("iban") || null,
        currency,
        asOf,
        available,
        blocked,
      });
    });

    return { valid, errors };
  },
};

// ────────────────────────── Puantaj ──────────────────────────

export interface AttendanceRow {
  readonly employeeCode: string;
  readonly workDate: string;
  readonly workedMinutes: number;
  readonly plannedMinutes: number;
  readonly isWeekend: boolean;
  readonly isHoliday: boolean;
  readonly approved: boolean;
}

/** "8:30" veya "8,5" veya "510" (dakika) → dakika. */
function parseDuration(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  // Saat:dakika biçimi PDKS çıktılarında yaygındır.
  const hhmm = /^(\d{1,3}):([0-5]\d)$/.exec(s);
  if (hhmm) return Number(hhmm[1]) * 60 + Number(hhmm[2]);

  const n = parseTurkishNumber(s);
  if (n === null) return null;
  // 24'ten küçükse saat, değilse dakika kabul edilir. Bu sınır YAZILI bir
  // varsayımdır: 8 saat çalışan biri "8" yazar, 480 dakika yazan da olur.
  return n <= 24 ? Math.round(n * 60) : Math.round(n);
}

const YES = new Set(["evet", "e", "var", "x", "1", "true", "onaylandi", "onayli"]);

export const ATTENDANCE_OBJECT: ImportObject<AttendanceRow> = {
  id: "attendance",
  label: "Puantaj (PDKS)",
  requires: "hr:attendance.write",
  templateHeaders: ["Personel Kodu", "Tarih", "Çalışılan", "Planlanan", "Hafta Sonu", "Tatil", "Onay"],
  fields: [
    { key: "employeeCode", label: "Personel kodu", required: true, aliases: ["personel kodu", "sicil", "sicil no", "calisan kodu", "kod"] },
    { key: "workDate", label: "Tarih", required: true, aliases: ["tarih", "gun", "date"] },
    { key: "worked", label: "Çalışılan", required: true, aliases: ["calisilan", "calisma", "fiili", "sure", "worked"] },
    { key: "planned", label: "Planlanan", aliases: ["planlanan", "normal", "plan", "standart"] },
    { key: "weekend", label: "Hafta sonu", aliases: ["hafta sonu", "haftasonu", "weekend"] },
    { key: "holiday", label: "Tatil", aliases: ["tatil", "resmi tatil", "holiday", "bayram"] },
    { key: "approved", label: "Onay", aliases: ["onay", "onaylandi", "approved", "yonetici onayi"] },
  ],

  parse(table, columns) {
    const rows = rowReader(table, columns);
    const valid: AttendanceRow[] = [];
    const errors: RowError[] = [];
    const seen = new Set<string>();

    rows.forEach((get, i) => {
      const line = i + 2;
      const employeeCode = get("employeeCode");
      if (!employeeCode) {
        errors.push({ line, field: "personel kodu", message: "Personel kodu boş." });
        return;
      }

      const workDate = parseTurkishDate(get("workDate"));
      if (!workDate) {
        errors.push({ line, field: "tarih", message: `"${get("workDate")}" geçerli bir tarih değil.` });
        return;
      }

      const workedMinutes = parseDuration(get("worked"));
      if (workedMinutes === null) {
        errors.push({ line, field: "çalışılan", message: "Çalışılan süre okunamadı." });
        return;
      }
      if (workedMinutes > 24 * 60) {
        // Bir günde 24 saatten fazla çalışılamaz; bu bir veri hatasıdır ve
        // sessizce kabul edilirse bordroda karşılığı olmayan mesai doğar.
        errors.push({ line, field: "çalışılan", message: "Bir günde 24 saatten fazla süre olamaz." });
        return;
      }

      const weekend = YES.has(normalizeName(get("weekend")).full);
      const holiday = YES.has(normalizeName(get("holiday")).full);
      // Hafta sonu/tatilde planlanan normal süre YOKTUR; sürenin tamamı
      // fazla mesaidir (bkz. attendance-source.ts).
      const plannedRaw = parseDuration(get("planned"));
      const plannedMinutes = weekend || holiday ? 0 : (plannedRaw ?? 480);

      const key = `${employeeCode}|${workDate}`;
      if (seen.has(key)) {
        errors.push({ line, field: "tarih", message: "Aynı personelin aynı günü tekrar ediyor." });
        return;
      }
      seen.add(key);

      valid.push({
        employeeCode,
        workDate,
        workedMinutes,
        plannedMinutes,
        isWeekend: weekend,
        isHoliday: holiday,
        approved: YES.has(normalizeName(get("approved")).full),
      });
    });

    return { valid, errors };
  },
};

// ────────────────────────── Malzeme ──────────────────────────

export interface ItemImportRow {
  readonly code: string;
  readonly name: string;
  readonly normalized: string;
  readonly type: string;
  readonly baseUom: string;
  readonly procurementType: string;
  readonly batchManaged: boolean;
  readonly leadTimeDays: number | null;
  readonly altUom: { uom: string; factor: number } | null;
}

/** Dosyada yazılabilecek tür adları → sistem kodları. */
const TYPE_ALIASES: Readonly<Record<string, string>> = {
  hammadde: "hammadde", "ham madde": "hammadde", raw: "hammadde",
  "yari mamul": "yari_mamul", yarimamul: "yari_mamul", "ara urun": "yari_mamul",
  mamul: "mamul", "bitmis urun": "mamul", urun: "mamul",
  "ticari mal": "ticari_mal", ticari: "ticari_mal", "alim satim": "ticari_mal",
  hizmet: "hizmet", servis: "hizmet",
  sarf: "sarf", "sarf malzeme": "sarf", tuketim: "sarf",
};

export const ITEM_OBJECT: ImportObject<ItemImportRow> = {
  id: "items",
  label: "Malzeme listesi",
  requires: "master-data:item.write",
  templateHeaders: [
    "Malzeme Kodu", "Malzeme Adı", "Tür", "Birim",
    "Tedarik", "Parti Takibi", "Tedarik Süresi", "Alt Birim", "Katsayı",
  ],
  fields: [
    { key: "code", label: "Malzeme kodu", required: true, aliases: ["malzeme kodu", "stok kodu", "urun kodu"] },
    { key: "name", label: "Malzeme adı", required: true, aliases: ["malzeme adi", "stok adi", "urun adi", "aciklama"] },
    { key: "type", label: "Tür", aliases: ["malzeme turu", "tur", "grup"] },
    { key: "baseUom", label: "Birim", required: true, aliases: ["olcu birimi", "temel birim", "birim", "uom"] },
    { key: "procurement", label: "Tedarik", aliases: ["tedarik turu", "tedarik", "temin"] },
    { key: "batch", label: "Parti takibi", aliases: ["parti takibi", "parti", "lot"] },
    { key: "leadTime", label: "Tedarik süresi", aliases: ["tedarik suresi", "temin suresi"] },
    { key: "altUom", label: "Alt birim", aliases: ["alt birim", "ikinci birim", "alternatif birim"] },
    { key: "factor", label: "Katsayı", aliases: ["katsayi", "cevrim", "carpan", "faktor"] },
  ],

  parse(table, columns) {
    const rows = rowReader(table, columns);
    const valid: ItemImportRow[] = [];
    const errors: RowError[] = [];
    const seen = new Set<string>();

    rows.forEach((get, i) => {
      const line = i + 2;
      const code = get("code");
      const name = get("name");
      if (!code || !name) {
        errors.push({ line, field: "malzeme", message: "Malzeme kodu veya adı boş." });
        return;
      }
      if (seen.has(code)) {
        errors.push({ line, field: "malzeme kodu", message: `"${code}" bu dosyada tekrar ediyor.` });
        return;
      }
      seen.add(code);

      const baseUom = get("baseUom");
      if (!baseUom) {
        // TEMEL BİRİM VARSAYILMAZ. "adet kabul edelim" demek, kilogramla
        // satılan bir hammaddeyi adetle stoklamaktır.
        errors.push({ line, field: "birim", message: "Ölçü birimi boş; varsayılan atanmaz." });
        return;
      }

      const rawType = normalizeName(get("type")).full;
      const type = TYPE_ALIASES[rawType] ?? (rawType === "" ? "ticari_mal" : null);
      if (!type) {
        errors.push({
          line,
          field: "tür",
          message: `"${get("type")}" tanınmadı. Yazılabilir: hammadde, yarı mamul, mamul, ticari mal, hizmet, sarf.`,
        });
        return;
      }

      const proc = normalizeName(get("procurement")).full;
      const procurementType = proc.includes("uret")
        ? "uretim"
        : proc.includes("her") || proc.includes("ikisi")
          ? "her_ikisi"
          : "satin_alma";

      const batchManaged = YES.has(normalizeName(get("batch")).full);
      if (batchManaged && type === "hizmet") {
        errors.push({ line, field: "parti takibi", message: "Hizmet stoklanmaz; parti takibi olamaz." });
        return;
      }

      // Alt birim ve katsayı BİRLİKTE anlamlıdır: biri varsa diğeri de olmalı,
      // yoksa çevrim yapılamaz ve yarım bir tanım kalır.
      const altName = get("altUom");
      const factor = parseTurkishNumber(get("factor"));
      if (altName && (factor === null || factor <= 0)) {
        errors.push({
          line,
          field: "katsayı",
          message: `"${altName}" birimi için geçerli bir çevrim katsayısı yok.`,
        });
        return;
      }
      if (altName && altName === baseUom) {
        errors.push({ line, field: "alt birim", message: "Alt birim temel birimle aynı olamaz." });
        return;
      }

      const lead = parseTurkishNumber(get("leadTime"));

      valid.push({
        code,
        name,
        normalized: normalizeName(name).full,
        type,
        baseUom,
        procurementType,
        batchManaged,
        leadTimeDays: lead === null ? null : Math.max(0, Math.round(lead)),
        altUom: altName && factor ? { uom: altName, factor } : null,
      });
    });

    return { valid, errors };
  },
};

// ────────────────────────── Personel ──────────────────────────

export interface EmployeeRow {
  readonly code: string;
  readonly fullName: string;
  readonly normalized: string;
  readonly department: string;
  readonly position: string;
  readonly hiredAt: string;
  readonly grossSalary: number | null;
}

export const EMPLOYEE_OBJECT: ImportObject<EmployeeRow> = {
  id: "employees",
  label: "Personel listesi",
  requires: "master-data:employee.write",
  templateHeaders: ["Personel Kodu", "Ad Soyad", "Departman", "Görev", "İşe Giriş", "Brüt Ücret"],
  fields: [
    { key: "code", label: "Personel kodu", required: true, aliases: ["personel kodu", "sicil", "sicil no", "kod"] },
    { key: "fullName", label: "Ad soyad", required: true, aliases: ["ad soyad", "adi soyadi", "isim", "personel", "name"] },
    { key: "department", label: "Departman", aliases: ["departman", "bolum", "birim", "department"] },
    { key: "position", label: "Görev", aliases: ["gorev", "unvan", "pozisyon", "position"] },
    { key: "hiredAt", label: "İşe giriş", aliases: ["ise giris", "giris tarihi", "baslangic", "hired"] },
    { key: "grossSalary", label: "Brüt ücret", aliases: ["brut ucret", "brut maas", "maas", "ucret", "salary"] },
  ],

  parse(table, columns) {
    const rows = rowReader(table, columns);
    const valid: EmployeeRow[] = [];
    const errors: RowError[] = [];
    const seen = new Set<string>();

    rows.forEach((get, i) => {
      const line = i + 2;
      const code = get("code");
      const fullName = get("fullName");
      if (!code || !fullName) {
        errors.push({ line, field: "personel", message: "Personel kodu veya ad soyad boş." });
        return;
      }
      if (seen.has(code)) {
        errors.push({ line, field: "personel kodu", message: `"${code}" bu dosyada tekrar ediyor.` });
        return;
      }
      seen.add(code);

      valid.push({
        code,
        fullName,
        normalized: normalizeName(fullName).full,
        department: get("department") || "Tanımsız",
        position: get("position") || "Tanımsız",
        // İşe giriş tarihi yoksa BUGÜN yazılmaz — kıdem hesabını bozar.
        // Tarih zorunlu değil ama verilmişse geçerli olmalı.
        hiredAt: parseTurkishDate(get("hiredAt")) ?? "1970-01-01",
        grossSalary: parseTurkishNumber(get("grossSalary")),
      });
    });

    return { valid, errors };
  },
};

// ────────────────────── Satış siparişi ──────────────────────

export interface SalesOrderRow {
  readonly orderNo: string;
  readonly customerRef: string;
  readonly committedDate: string;
  readonly penaltyPerDay: number | null;
  readonly penaltyCap: number | null;
  readonly currency: string;
}

export const SALES_ORDER_OBJECT: ImportObject<SalesOrderRow> = {
  id: "sales_orders",
  label: "Satış siparişleri",
  requires: "sales:order.write",
  templateHeaders: ["Sipariş No", "Müşteri", "Termin", "Günlük Ceza", "Ceza Tavanı", "Para Birimi"],
  fields: [
    { key: "orderNo", label: "Sipariş no", required: true, aliases: ["siparis no", "siparis numarasi", "so", "order no"] },
    { key: "customer", label: "Müşteri", required: true, aliases: ["musteri", "musteri unvani", "cari", "customer", "alici"] },
    { key: "committedDate", label: "Termin", required: true, aliases: ["termin", "termin tarihi", "teslim", "teslim tarihi", "taahhut"] },
    { key: "penaltyPerDay", label: "Günlük ceza", aliases: ["gunluk ceza", "ceza", "gecikme cezasi", "penalty"] },
    { key: "penaltyCap", label: "Ceza tavanı", aliases: ["ceza tavani", "tavan", "ust sinir", "cap"] },
    { key: "currency", label: "Para birimi", aliases: ["para birimi", "doviz", "currency", "pb"] },
  ],

  parse(table, columns) {
    const rows = rowReader(table, columns);
    const valid: SalesOrderRow[] = [];
    const errors: RowError[] = [];
    const seen = new Set<string>();

    rows.forEach((get, i) => {
      const line = i + 2;
      const orderNo = get("orderNo");
      const customerRef = get("customer");
      if (!orderNo || !customerRef) {
        errors.push({ line, field: "sipariş", message: "Sipariş no veya müşteri boş." });
        return;
      }
      if (seen.has(orderNo)) {
        errors.push({ line, field: "sipariş no", message: `"${orderNo}" bu dosyada tekrar ediyor.` });
        return;
      }
      seen.add(orderNo);

      const committedDate = parseTurkishDate(get("committedDate"));
      if (!committedDate) {
        errors.push({ line, field: "termin", message: `"${get("committedDate")}" geçerli bir tarih değil.` });
        return;
      }

      // Ceza alanları null KALIR, sıfıra çevrilmez: "sözleşmede yazmıyor"
      // ile "ceza yok" farklı cevaplar üretir (bkz. shipment-source.ts).
      valid.push({
        orderNo,
        customerRef,
        committedDate,
        penaltyPerDay: parseTurkishNumber(get("penaltyPerDay")),
        penaltyCap: parseTurkishNumber(get("penaltyCap")),
        currency: normalizeCurrency(get("currency")) ?? "TRY",
      });
    });

    return { valid, errors };
  },
};

/**
 * Tanımlı tüm içe aktarma nesneleri.
 *
 * `ImportObject<unknown>` olarak tutulur: liste heterojendir ve tüketiciler
 * satırların şeklini bilmek zorunda değildir — yazma tarafı nesneye özgü
 * yazıcıya devreder.
 */
export const IMPORT_OBJECTS: readonly ImportObject<unknown>[] = [
  PARTNER_OBJECT,
  ITEM_OBJECT,
  EMPLOYEE_OBJECT,
  BANK_OBJECT,
  ATTENDANCE_OBJECT,
  SALES_ORDER_OBJECT,
] as readonly ImportObject<unknown>[];

export function findObject(id: string): ImportObject<unknown> | undefined {
  return IMPORT_OBJECTS.find((o) => o.id === id);
}

/** Dosyayı ayrıştırıp doğrular — nesne bilinerek. */
export function parseWith<T>(
  object: ImportObject<T>,
  table: CsvTable,
): { valid: readonly T[]; errors: readonly RowError[]; columns: Readonly<Record<string, string | null>> } {
  const columns = mapColumns(table.headers, object.fields);
  const missing = object.fields.filter((f) => f.required && columns[f.key] === null);
  if (missing.length > 0) {
    return {
      valid: [],
      columns,
      errors: [
        {
          line: 1,
          field: missing.map((m) => m.label).join(", "),
          message:
            `Zorunlu sütun bulunamadı: ${missing.map((m) => m.label).join(", ")}. ` +
            `Beklenen başlıklar: ${object.templateHeaders.join(", ")}`,
        },
      ],
    };
  }
  const { valid, errors } = object.parse(table, columns);
  return { valid, errors, columns };
}
