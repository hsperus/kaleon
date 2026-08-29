/**
 * Cari kartı içe aktarma.
 *
 * TASARIMIN OMURGASI: ÖNCE GÖSTER, SONRA YAZ.
 *
 * İçe aktarma iki adımdır ve ayrı olmaları zorunludur:
 *   1. ÖNİZLEME — hiçbir şey yazılmaz. Kaç satır geçerli, kaç satır hatalı,
 *      hangileri mevcut kayıtla çakışıyor, hepsi RAPORLANIR.
 *   2. ONAY VE YAZMA — kullanıcı raporu gördükten sonra onaylar.
 *
 * Tek adımlı bir içe aktarma, 4000 satırlık bir dosyanın 900'ünü bozuk
 * yazdıktan sonra durur ve geri alınamaz. ERP'de en sık yaşanan felaket
 * budur.
 *
 * İKİNCİ İLKE: HATALI SATIR TÜM DOSYAYI DURDURMAZ.
 * Bir satırda VKN yanlışsa o satır reddedilir, diğerleri yazılır ve
 * reddedilenler satır numarasıyla listelenir. "Hepsi ya da hiçbiri" kuralı
 * kulağa güvenli gelir ama pratikte kullanıcıyı 4000 satırlık dosyayı tek
 * bir hatalı hücre için yeniden yüklemeye zorlar.
 */

import { isValidTckn, isValidVkn } from "../master-data/identifiers.js";
import { normalizeName } from "../master-data/normalize.js";
import { toRecords, type CsvTable } from "./csv.js";

/** Bir cari kaydının içe aktarılabilir hâli. */
export interface PartnerImportRow {
  readonly code: string;
  readonly legalName: string;
  readonly normalized: string;
  readonly taxId: { kind: "vkn" | "tckn"; value: string } | null;
  readonly externalRef: { system: string; externalId: string } | null;
  readonly isSupplier: boolean;
  readonly isCustomer: boolean;
}

export interface RowError {
  /** Dosyadaki satır numarası — başlık 1'dir, veri 2'den başlar. */
  readonly line: number;
  readonly field: string;
  readonly message: string;
}

export interface ImportPreview {
  readonly valid: readonly PartnerImportRow[];
  readonly errors: readonly RowError[];
  readonly detectedColumns: Readonly<Record<string, string | null>>;
  readonly totalRows: number;
}

/**
 * Başlık eşlemesi.
 *
 * Kullanıcıya "sütunları eşleştir" ekranı göstermeden önce otomatik dene:
 * Türk muhasebe yazılımlarının çıktıları birbirine benzer ve çoğu dosya
 * elle eşleme gerektirmez. Bulunamayan alan `null` kalır ve rapora girer —
 * SESSİZCE ATLANMAZ.
 */
const COLUMN_ALIASES: Record<keyof typeof FIELDS, readonly string[]> = {
  code: ["cari kodu", "cari kod", "kod", "code", "musteri kodu", "tedarikci kodu"],
  legalName: ["unvan", "ticari unvan", "firma", "firma adi", "cari adi", "ad", "name", "unvani"],
  taxId: ["vkn", "vergi no", "vergi kimlik no", "vergi numarasi", "tckn", "tc kimlik", "tax id"],
  externalId: ["entegrator kodu", "dis kod", "harici kod", "external id", "referans"],
  type: ["tur", "tip", "cari turu", "type"],
};

const FIELDS = {
  code: true,
  legalName: true,
  taxId: true,
  externalId: true,
  type: true,
} as const;

/** Başlık adlarını karşılaştırmak için sadeleştirir (Türkçe duyarlı). */
function foldHeader(h: string): string {
  return normalizeName(h).full;
}

export function detectColumns(
  headers: readonly string[],
): Readonly<Record<keyof typeof FIELDS, string | null>> {
  const folded = headers.map((h) => ({ raw: h, key: foldHeader(h) }));
  const out = {} as Record<keyof typeof FIELDS, string | null>;

  for (const field of Object.keys(FIELDS) as (keyof typeof FIELDS)[]) {
    const aliases = COLUMN_ALIASES[field].map(foldHeader);
    // Önce tam eşleşme, sonra içerme: "Cari Kodu" tam eşleşirken
    // "Müşteri Cari Kodu (eski)" ancak içermeyle bulunur.
    const hit =
      folded.find((h) => aliases.includes(h.key)) ??
      folded.find((h) => aliases.some((a) => h.key.includes(a)));
    out[field] = hit?.raw ?? null;
  }
  return out;
}

export interface PreviewOptions {
  /** Otomatik eşlemeyi geçersiz kılan elle eşleme. */
  readonly columns?: Partial<Record<keyof typeof FIELDS, string>>;
  /** Entegratör kodu hangi sistemden geliyor? */
  readonly externalSystem?: string;
}

export function previewPartnerImport(table: CsvTable, opts: PreviewOptions = {}): ImportPreview {
  const detected = { ...detectColumns(table.headers), ...opts.columns };
  const records = toRecords(table);
  const valid: PartnerImportRow[] = [];
  const errors: RowError[] = [];

  // Unvan olmadan cari kartı olmaz; bu eksikse satır satır uğraşmanın anlamı
  // yok, dosyanın tamamı reddedilir ve sebep TEK cümlede söylenir.
  if (!detected.legalName) {
    return {
      valid: [],
      errors: [
        {
          line: 1,
          field: "unvan",
          message:
            "Unvan sütunu bulunamadı. Beklenen başlıklar: " +
            COLUMN_ALIASES.legalName.slice(0, 4).join(", "),
        },
      ],
      detectedColumns: detected,
      totalRows: records.length,
    };
  }

  const seenCodes = new Set<string>();
  const seenTaxIds = new Set<string>();

  records.forEach((record, index) => {
    const line = index + 2; // başlık 1. satır
    const legalName = (record[detected.legalName!] ?? "").trim();

    if (!legalName) {
      errors.push({ line, field: "unvan", message: "Unvan boş." });
      return;
    }

    // ── Vergi numarası
    let taxId: PartnerImportRow["taxId"] = null;
    const rawTax = detected.taxId ? (record[detected.taxId] ?? "").replace(/\D/g, "") : "";
    if (rawTax) {
      if (rawTax.length === 10 && isValidVkn(rawTax)) taxId = { kind: "vkn", value: rawTax };
      else if (rawTax.length === 11 && isValidTckn(rawTax)) taxId = { kind: "tckn", value: rawTax };
      else {
        // GEÇERSİZ VKN SESSİZCE KAYDEDİLMEZ. Yanlış bir vergi numarası,
        // ileride iki farklı firmayı birleştirebilir veya e-fatura
        // eşleştirmesini bozar. Satır reddedilir ve sebep söylenir.
        errors.push({
          line,
          field: "vergi no",
          message: `"${record[detected.taxId!]}" geçerli bir VKN/TCKN değil (kontrol hanesi tutmuyor).`,
        });
        return;
      }

      if (seenTaxIds.has(taxId.value)) {
        errors.push({
          line,
          field: "vergi no",
          message: `${taxId.value} bu dosyada birden fazla satırda var.`,
        });
        return;
      }
      seenTaxIds.add(taxId.value);
    }

    // ── Cari kodu: yoksa üretilir ama dosyadaki tekrar yakalanır
    const rawCode = detected.code ? (record[detected.code] ?? "").trim() : "";
    const code = rawCode || generateCode(legalName, index);
    if (seenCodes.has(code)) {
      errors.push({ line, field: "cari kodu", message: `"${code}" bu dosyada tekrar ediyor.` });
      return;
    }
    seenCodes.add(code);

    // ── Tür: belirtilmemişse TEDARİKÇİ VARSAYILMAZ. Yanlış tür, cariyi
    //    yanlış listelerde gösterir; ikisini birden işaretlemek daha az
    //    zararlıdır ve kullanıcı düzeltebilir.
    const rawType = detected.type ? foldHeader(record[detected.type] ?? "") : "";
    const isSupplier = rawType.includes("tedarik") || rawType.includes("satici") || rawType === "";
    const isCustomer = rawType.includes("musteri") || rawType.includes("alici") || rawType === "";

    const externalId = detected.externalId ? (record[detected.externalId] ?? "").trim() : "";

    valid.push({
      code,
      legalName,
      normalized: normalizeName(legalName).core,
      taxId,
      externalRef:
        externalId && opts.externalSystem
          ? { system: opts.externalSystem, externalId }
          : null,
      isSupplier,
      isCustomer,
    });
  });

  return { valid, errors, detectedColumns: detected, totalRows: records.length };
}

/**
 * Cari kodu yoksa üretilir.
 *
 * Unvandan türetilir ki kullanıcı listede tanısın; sıra numarası çakışmayı
 * engeller. Rastgele bir kod okunmaz ve elle aramayı imkânsız kılar.
 */
function generateCode(legalName: string, index: number): string {
  const slug = normalizeName(legalName)
    .core.replace(/[^a-z0-9]/g, "")
    .slice(0, 8)
    .toUpperCase();
  return `${slug || "CARI"}-${String(index + 1).padStart(4, "0")}`;
}
