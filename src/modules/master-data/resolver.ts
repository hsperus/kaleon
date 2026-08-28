/**
 * Entity Resolution motoru.
 *
 * Ürün Mantığı §9: "Entity Resolution, KAELON'un cevap kalitesinin görünmez
 * ama belirleyici katmanıdır." Aynı tedarikçi farklı kaynaklarda farklı isimle
 * gelir; eşleşme kurulamazsa Document Intelligence ve Finance sorgularının
 * TAMAMI yanlış cevap verir.
 *
 * Motorun iki kuralı vardır ve ikisi de yanlış birleştirmeye karşıdır:
 *
 *  1. **Deterministik önce.** Geçerli vergi numarası veya entegratör kimliği
 *     varsa bulanık eşleşmeye hiç bakılmaz.
 *  2. **Belirsizlik otomatik çözülmez.** İki aday da yüksek skor alıyorsa
 *     sistem karar vermez, insana sorar. Yanlış birleştirmenin geri alınması
 *     çok pahalıdır; bekletmek ucuzdur.
 */

import {
  fuzzyTokenSimilarity,
  isTokenSubset,
  jaroWinkler,
  normalizeName,
  tokenSimilarity,
  type NormalizedName,
} from "./normalize.js";
import { parseTaxId } from "./identifiers.js";

/** Otomatik eşleşme eşiği — bunun üstü insan onayı istemez. */
export const AUTO_MATCH = 0.92;
/** İnceleme eşiği — bunun altı eşleşme sayılmaz. */
export const REVIEW_MATCH = 0.75;
/** İki aday arasındaki fark bundan küçükse belirsizdir. */
export const AMBIGUITY_MARGIN = 0.04;

export type MatchMethod =
  | "tax_id"
  | "external_ref"
  | "exact_name"
  | "core_name"
  | "alias"
  | "token_subset"
  | "fuzzy_name";

/**
 * Alias'ın nereden geldiği eşleşme gücünü belirler.
 *  - `confirmed`  : yetkili kullanıcı onayladı → otomatik eşleşme kurabilir.
 *  - `automatic`  : sistem yüksek güvenle kurdu → otomatik eşleşme kurabilir.
 *  - `observed`   : entegratör verisinde görüldü, doğrulanmadı → TEK BAŞINA
 *                   otomatik eşleşme kuramaz; incelemeye düşer.
 *
 * Ayrım önemli: doğrulanmamış bir alias'a dayanarak iki firmayı birleştirmek,
 * yanlış birleştirmelerin en yaygın kaynağıdır.
 */
export type AliasSource = "observed" | "confirmed" | "automatic";

export interface PartnerAlias {
  readonly alias: string;
  readonly source: AliasSource;
}

export interface PartnerCandidate {
  readonly partnerId: string;
  readonly legalName: string;
  readonly taxIds: readonly { kind: string; value: string; valid: boolean }[];
  readonly externalRefs: readonly { system: string; externalId: string }[];
  readonly aliases: readonly PartnerAlias[];
  /** Bu kayıt başka bir partner'a birleştirildiyse hedefi. */
  readonly mergedInto?: string | null;
}

export interface ResolveQuery {
  readonly name?: string | null;
  readonly taxId?: string | null;
  readonly externalRef?: { system: string; externalId: string } | null;
}

export interface Match {
  readonly partnerId: string;
  readonly legalName: string;
  readonly confidence: number;
  readonly method: MatchMethod;
  /** Eşleşmenin neden kurulduğunun insan tarafından okunabilir gerekçesi. */
  readonly evidence: string;
}

export type Resolution =
  | { readonly status: "resolved"; readonly match: Match }
  | { readonly status: "review"; readonly candidates: readonly Match[]; readonly reason: string }
  | { readonly status: "not_found" };

interface Prepared {
  readonly candidate: PartnerCandidate;
  readonly name: NormalizedName;
  readonly aliasNames: readonly { form: NormalizedName; source: AliasSource }[];
}

function prepare(c: PartnerCandidate): Prepared {
  return {
    candidate: c,
    name: normalizeName(c.legalName),
    aliasNames: c.aliases.map((a) => ({ form: normalizeName(a.alias), source: a.source })),
  };
}

/** Doğrulanmamış alias otomatik eşiğin altında tutulur. */
const ALIAS_EXACT_CONFIDENCE: Record<AliasSource, number> = {
  confirmed: 0.96,
  automatic: 0.93,
  observed: 0.88,
};

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Tek bir aday için en iyi ad-bazlı skoru üretir. */
function scoreByName(query: NormalizedName, p: Prepared): Match | null {
  const forms: { form: NormalizedName; label: string; alias: AliasSource | null }[] = [
    { form: p.name, label: "unvan", alias: null },
    ...p.aliasNames.map((a, i) => ({
      form: a.form,
      label: `alias#${i + 1} (${a.source})`,
      alias: a.source,
    })),
  ];

  let best: Match | null = null;
  const consider = (m: Match) => {
    if (!best || m.confidence > best.confidence) best = m;
  };

  for (const { form, label, alias } of forms) {
    if (form.full && form.full === query.full) {
      consider({
        partnerId: p.candidate.partnerId,
        legalName: p.candidate.legalName,
        confidence: alias ? ALIAS_EXACT_CONFIDENCE[alias] : 0.97,
        method: alias ? "alias" : "exact_name",
        evidence: `${label} tam eşleşme: "${form.full}"`,
      });
      continue;
    }

    if (form.core && form.core === query.core) {
      consider({
        partnerId: p.candidate.partnerId,
        legalName: p.candidate.legalName,
        confidence: alias ? ALIAS_EXACT_CONFIDENCE[alias] - 0.02 : 0.94,
        method: alias ? "alias" : "core_name",
        evidence: `çekirdek unvan eşleşmesi: "${form.core}" (tüzel ekler düşüldü)`,
      });
      continue;
    }

    const exactTokens = tokenSimilarity(query.tokens, form.tokens);

    if (isTokenSubset(query.tokens, form.tokens)) {
      consider({
        partnerId: p.candidate.partnerId,
        legalName: p.candidate.legalName,
        confidence: round(Math.min(0.91, 0.84 + exactTokens * 0.07)),
        method: "token_subset",
        evidence: `sorgu unvanı adayın içinde geçiyor (${label}); token örtüşmesi ${round(exactTokens)}`,
      });
      continue;
    }

    // Yazım hatalarına dayanıklı token eşleştirmesi — keskin Jaccard
    // çok kelimeli hatalarda çöker.
    const tokenSim = Math.max(exactTokens, fuzzyTokenSimilarity(query.tokens, form.tokens));
    const jw = jaroWinkler(query.core, form.core);
    const blended = jw * 0.55 + tokenSim * 0.45;
    if (blended >= 0.6) {
      consider({
        partnerId: p.candidate.partnerId,
        legalName: p.candidate.legalName,
        // Bulanık eşleşme asla otomatik eşiğe ulaşamaz — tavan 0.90.
        confidence: round(Math.min(0.9, blended)),
        method: "fuzzy_name",
        evidence: `bulanık unvan benzerliği ${round(blended)} (jw ${round(jw)}, token ${round(tokenSim)})`,
      });
    }
  }

  return best;
}

/**
 * Sorguyu adaylar arasında çözer.
 *
 * `candidates` çağıran tarafından veritabanından getirilir (indeksli ön
 * eleme). Motor saf fonksiyondur: veritabanı bilmez, test edilebilir.
 */
export function resolvePartner(
  query: ResolveQuery,
  candidates: readonly PartnerCandidate[],
): Resolution {
  const prepared = candidates.map(prepare);

  // ── 1. Deterministik: geçerli vergi numarası
  if (query.taxId) {
    const parsed = parseTaxId(query.taxId);
    if (parsed?.valid) {
      const hit = prepared.find((p) =>
        p.candidate.taxIds.some((t) => t.valid && t.value === parsed.value),
      );
      if (hit) {
        return {
          status: "resolved",
          match: {
            partnerId: followMerge(hit.candidate, candidates),
            legalName: hit.candidate.legalName,
            confidence: 1,
            method: "tax_id",
            evidence: `${parsed.kind.toUpperCase()} ${parsed.value} checksum doğrulandı ve eşleşti`,
          },
        };
      }
    }
  }

  // ── 2. Deterministik: entegratör kimliği
  if (query.externalRef) {
    const { system, externalId } = query.externalRef;
    const hit = prepared.find((p) =>
      p.candidate.externalRefs.some(
        (r) => r.system === system && r.externalId === externalId,
      ),
    );
    if (hit) {
      return {
        status: "resolved",
        match: {
          partnerId: followMerge(hit.candidate, candidates),
          legalName: hit.candidate.legalName,
          confidence: 0.99,
          method: "external_ref",
          evidence: `${system} kimliği "${externalId}" eşleşti`,
        },
      };
    }
  }

  // ── 3. Ad bazlı
  if (!query.name?.trim()) return { status: "not_found" };

  const q = normalizeName(query.name);
  const scored = prepared
    .map((p) => scoreByName(q, p))
    .filter((m): m is Match => m !== null && m.confidence >= REVIEW_MATCH)
    .sort((a, b) => b.confidence - a.confidence);

  if (scored.length === 0) return { status: "not_found" };

  const top = scored[0]!;
  const runnerUp = scored[1];

  // Belirsizlik koruması: iki aday da güçlüyse sistem karar vermez.
  if (runnerUp && top.confidence - runnerUp.confidence < AMBIGUITY_MARGIN) {
    return {
      status: "review",
      candidates: scored.slice(0, 5),
      reason:
        `İki aday birbirine çok yakın (${round(top.confidence)} ve ` +
        `${round(runnerUp.confidence)}). Yanlış birleştirme riski nedeniyle ` +
        `otomatik karar verilmedi.`,
    };
  }

  if (top.confidence >= AUTO_MATCH) {
    return {
      status: "resolved",
      match: { ...top, partnerId: followMergeById(top.partnerId, candidates) },
    };
  }

  return {
    status: "review",
    candidates: scored.slice(0, 5),
    reason: `En iyi aday ${round(top.confidence)} güvenle eşleşti; otomatik eşik ${AUTO_MATCH}.`,
  };
}

/** Birleştirilmiş kayıtları hedefe kadar takip eder (döngü korumalı). */
function followMerge(
  candidate: PartnerCandidate,
  all: readonly PartnerCandidate[],
): string {
  return followMergeById(candidate.partnerId, all);
}

function followMergeById(id: string, all: readonly PartnerCandidate[]): string {
  const seen = new Set<string>();
  let current = id;
  for (let i = 0; i < 10; i++) {
    if (seen.has(current)) break;
    seen.add(current);
    const node = all.find((c) => c.partnerId === current);
    if (!node?.mergedInto) break;
    current = node.mergedInto;
  }
  return current;
}
