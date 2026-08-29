/**
 * Entity resolution için aday getirme — Postgres adaptörü.
 *
 * MOTOR SAF KALIR, ÖN ELEME BURADA YAPILIR.
 * `resolvePartner` bütün skorlamayı bellekte yapar ve test edilebilir olması
 * için öyle kalmalıdır. Ama on binlerce cariyi belleğe çekip skorlamak
 * kabul edilemez. Bu adaptörün tek işi, doğru cevabı İÇEREN küçük bir aday
 * kümesi getirmektir.
 *
 * ÜÇ ÖN ELEME KANALI — hepsi indeksli:
 *
 *   1. VERGİ NO — tam eşleşme (`partner_tax_ids.value` indeksi).
 *      En güçlü kanal; tek başına doğru cevabı getirir.
 *   2. ENTEGRATÖR KİMLİĞİ — tam eşleşme (`system + external_id` unique).
 *   3. AD — normalize edilmiş çekirdeğin İLK TOKEN'ı ile prefix araması
 *      (`partners.normalized` ve `partner_aliases.normalized` btree
 *      indeksleri `LIKE 'burcelik%'` sorgusunu kullanabilir).
 *
 * ÜÇÜNCÜ KANALIN RECALL SINIRI YAZILI OLSUN:
 * İlk token yanlış yazılmışsa ("Burcelik" yerine "Burçlik") prefix araması
 * kaçırır. Türk firma adlarında ayırt edici kelime başta olduğu için pratikte
 * yüksek recall verir; yine de kesin çözüm `pg_trgm` üzerine bir GIN indeksi.
 * O eklenti kurulum gerektirdiği için şimdilik yazılmadı — eksikliği burada
 * duruyor ki kimse "fuzzy arama var" sanmasın.
 */

import type { DataSource, PartnerCandidateRow, PartnerHint, WithFreshness } from "../data/port.js";
import { normalizeName } from "../modules/master-data/normalize.js";
import { isValidTckn, isValidVkn } from "../modules/master-data/identifiers.js";
import { PrismaAttendanceSource } from "./attendance-source.js";
import { PrismaShipmentSource } from "./shipment-source.js";
import { PrismaWipSource } from "./wip-source.js";
import { toMoneyRequired } from "./decimal.js";
import type { TenantDb } from "./client.js";

/** Bir sorguda belleğe alınacak en fazla aday. */
const CANDIDATE_LIMIT = 200;

type PartnerWithRelations = {
  id: string;
  legalName: string;
  mergedInto: string | null;
  taxIds: { kind: string; value: string }[];
  externalRefs: { system: string; externalId: string }[];
  aliases: { alias: string; source: string }[];
};

const INCLUDE = {
  taxIds: { select: { kind: true, value: true } },
  externalRefs: { select: { system: true, externalId: true } },
  aliases: { select: { alias: true, source: true } },
} as const;

export class PrismaMasterDataSource {
  readonly #db: TenantDb;

  constructor(db: TenantDb) {
    this.#db = db;
  }

  async partnerCandidates(
    _tenantId: string,
    hint: PartnerHint,
  ): Promise<WithFreshness<readonly PartnerCandidateRow[]>> {
    const ids = new Set<string>();
    const collected: PartnerWithRelations[] = [];

    const take = (rows: PartnerWithRelations[]) => {
      for (const r of rows) {
        if (ids.has(r.id)) continue;
        ids.add(r.id);
        collected.push(r);
      }
    };

    // ── 1. Vergi numarası
    if (hint.taxId) {
      const digits = hint.taxId.replace(/\D/g, "");
      if (digits.length > 0) {
        take(
          await this.#db.partner.findMany({
            where: { taxIds: { some: { value: digits } } },
            include: INCLUDE,
            take: CANDIDATE_LIMIT,
          }),
        );
      }
    }

    // ── 2. Entegratör cari kodu
    if (hint.externalRef && collected.length < CANDIDATE_LIMIT) {
      const ref = await this.#db.partnerExternalRef.findUnique({
        where: {
          system_externalId: {
            system: hint.externalRef.system,
            externalId: hint.externalRef.externalId,
          },
        },
        select: { partnerId: true },
      });
      if (ref && !ids.has(ref.partnerId)) {
        take(
          await this.#db.partner.findMany({ where: { id: ref.partnerId }, include: INCLUDE }),
        );
      }
    }

    // ── 3. Ad — hem partner hem alias tablosunda prefix araması
    if (hint.name && collected.length < CANDIDATE_LIMIT) {
      const normalized = normalizeName(hint.name);
      const firstToken = normalized.tokens[0];

      if (firstToken && firstToken.length >= 2) {
        const remaining = () => CANDIDATE_LIMIT - collected.length;

        take(
          await this.#db.partner.findMany({
            where: { normalized: { startsWith: firstToken } },
            include: INCLUDE,
            take: remaining(),
          }),
        );

        if (collected.length < CANDIDATE_LIMIT) {
          const aliasHits = await this.#db.partnerAlias.findMany({
            where: { normalized: { startsWith: firstToken } },
            select: { partnerId: true },
            take: remaining(),
          });
          const missing = aliasHits.map((a) => a.partnerId).filter((id) => !ids.has(id));
          if (missing.length > 0) {
            take(
              await this.#db.partner.findMany({
                where: { id: { in: missing } },
                include: INCLUDE,
              }),
            );
          }
        }
      }
    }

    return {
      rows: collected.map(toCandidate),
      freshness: {
        // Cari kartları canlı okunur; senkronizasyon gecikmesi yoktur.
        syncedAt: new Date().toISOString(),
        recordCount: collected.length,
      },
    };
  }
}

/**
 * Vergi/TC numarası geçerli mi?
 *
 * Bilinmeyen tür (örn. AB VAT) için `false` DEĞİL, doğrulanmamış sayılır —
 * ama alan boolean olduğu için burada `false` döner ve çözümleyici bu
 * numarayı deterministik anahtar olarak kullanmaz. Yanlış pozitif bir
 * "geçerli", iki farklı firmayı birleştirebilirdi.
 */
function taxIdValid(kind: string, value: string): boolean {
  if (kind === "vkn") return isValidVkn(value);
  if (kind === "tckn") return isValidTckn(value);
  return false;
}

function toCandidate(p: PartnerWithRelations): PartnerCandidateRow {
  return {
    partnerId: p.id,
    legalName: p.legalName,
    mergedInto: p.mergedInto,
    // Geçerlilik SAKLANMAZ, HESAPLANIR: kayıt yazıldıktan sonra checksum
    // kuralı değişirse, saklanan bir "valid" alanı yalan söylemeye başlar.
    taxIds: p.taxIds.map((t) => ({
      kind: t.kind,
      value: t.value,
      valid: taxIdValid(t.kind, t.value),
    })),
    externalRefs: p.externalRefs.map((r) => ({ system: r.system, externalId: r.externalId })),
    aliases: p.aliases.map((a) => ({
      alias: a.alias,
      source: a.source as "observed" | "confirmed" | "automatic",
    })),
  };
}

/**
 * Banka bakiyeleri.
 *
 * GÜNCEL BAKİYE HESAPLANIR, SAKLANMAZ: her hesabın `as_of` değeri en büyük
 * anlık görüntüsü alınır. Tek bir güncellenebilir `balance` sütunu, bakiyenin
 * hangi ana ait olduğunu ve dün ne olduğunu kaybettirirdi.
 *
 * TAZELİK EN ESKİ KAYITTAN GELİR: üç bankadan ikisi beş dakika önce, biri
 * dün senkronize olduysa, kullanıcıya söylenecek doğru cevap "dün"dür.
 * En yenisini göstermek, bayat veriyi taze gibi sunmak olurdu.
 */
export class PrismaBankSource {
  readonly #db: TenantDb;

  constructor(db: TenantDb) {
    this.#db = db;
  }

  async balances(
    currency: string | null,
  ): Promise<WithFreshness<readonly import("../data/port.js").BankBalance[]>> {
    const accounts = await this.#db.bankAccount.findMany({
      where: { isActive: true, ...(currency ? { currency } : {}) },
      orderBy: [{ bank: "asc" }, { currency: "asc" }],
      include: {
        // Her hesabın YALNIZCA en güncel anlık görüntüsü.
        balances: { orderBy: { asOf: "desc" }, take: 1 },
      },
    });

    const rows: import("../data/port.js").BankBalance[] = [];
    let oldest: Date | null = null;

    for (const acc of accounts) {
      const snap = acc.balances[0];
      // Hesap açılmış ama hiç bakiye gelmemişse SIFIR YAZILMAZ — sıfır bir
      // iddiadır ve yanlış olur. Hesap listelenmez.
      if (!snap) continue;
      rows.push({
        bank: acc.bank,
        currency: acc.currency,
        // Sessiz hassasiyet kaybı yerine gürültülü hata: bkz. decimal.ts
        available: toMoneyRequired(snap.available, "bakiye"),
        blocked: toMoneyRequired(snap.blocked, "blokeli tutar"),
      });
      if (!oldest || snap.asOf < oldest) oldest = snap.asOf;
    }

    return {
      rows,
      freshness: {
        syncedAt: (oldest ?? new Date()).toISOString(),
        recordCount: rows.length,
      },
    };
  }
}

/**
 * Bir tenant için tam veri kaynağı.
 *
 * Bütün kanallar tenant'ın kendi şemasından okur. Bir kanalın verisi eksikse
 * uydurma değer değil, null ve gerekçesini taşıyan bir caveat döner —
 * cevabın hangi kısmının bilinmediği kullanıcıya kadar gider.
 */
export class PrismaDataSource implements DataSource {
  readonly #master: PrismaMasterDataSource;
  readonly #bank: PrismaBankSource;
  readonly #attendance: PrismaAttendanceSource;
  readonly #shipment: PrismaShipmentSource;
  readonly #wip: PrismaWipSource;

  constructor(db: TenantDb) {
    this.#master = new PrismaMasterDataSource(db);
    this.#bank = new PrismaBankSource(db);
    this.#attendance = new PrismaAttendanceSource(db);
    this.#shipment = new PrismaShipmentSource(db);
    this.#wip = new PrismaWipSource(db);
  }

  readonly connectedChannels = ["partners", "bank", "attendance", "sales", "wip"] as const;

  async wipSnapshot(): Promise<WithFreshness<import("../data/port.js").WipSnapshot>> {
    return this.#wip.wipSnapshot();
  }

  async shipmentRisks(): Promise<WithFreshness<readonly import("../data/port.js").ShipmentRisk[]>> {
    return this.#shipment.shipmentRisks();
  }

  async bankBalances(
    _tenantId: string,
    currency: string | null,
  ): Promise<WithFreshness<readonly import("../data/port.js").BankBalance[]>> {
    return this.#bank.balances(currency);
  }

  async overtime(
    _tenantId: string,
    args: { employeeQuery: string | null; department: string | null; period: string },
  ): Promise<WithFreshness<readonly import("../data/port.js").OvertimeRecord[]>> {
    return this.#attendance.overtime(args);
  }

  async partnerCandidates(
    tenantId: string,
    hint: PartnerHint,
  ): Promise<WithFreshness<readonly PartnerCandidateRow[]>> {
    return this.#master.partnerCandidates(tenantId, hint);
  }
}

