/**
 * Senkronizasyon boru hattı: getir → HAM SAKLA → dönüştür → kanonik yaz.
 *
 * SIRALAMA BİR KARARDIR, RASTLANTI DEĞİL.
 * Ham veri kanonik dönüşümden ÖNCE saklanır. Sebep: dönüşüm başarısız
 * olabilir (beklenmeyen alan, bozuk XML, tanınmayan vergi kodu). Eğer
 * dönüşüm başarılı olduğunda saklasaydık, hata durumunda elimizde hiçbir
 * kanıt kalmazdı ve "entegratör ne gönderdi" sorusu cevapsız kalırdı.
 * Şimdi: dönüşüm patlasa bile ham belge duruyor, insan inceleyebiliyor,
 * dönüştürücü düzeltilince yeniden çalıştırılabiliyor.
 *
 * TEK BELGE HATASI AKIŞI DURDURMAZ.
 * `data` sınıfı hata yalnızca o belgeyi düşürür; kalan belgeler işlenmeye
 * devam eder. Bir bozuk fatura yüzünden günün tüm faturalarının gelmemesi,
 * klasik entegrasyonların en sık şikâyetidir.
 */

import {
  IntegrationError,
  checksum,
  type FetchWindow,
  type IntegrationAdapter,
  type RawDocument,
} from "./adapter.js";

export interface StoredRaw {
  readonly id: string;
  readonly source: string;
  readonly externalId: string;
  readonly checksum: string;
  readonly status: "pending" | "transformed" | "failed";
}

/** Boru hattının ihtiyaç duyduğu kalıcılık yüzeyi. */
export interface IntegrationStore {
  /** Ham belgeyi saklar. Aynı (source, externalId) varsa mevcut kaydı döner. */
  putRaw(input: {
    source: string;
    kind: string;
    externalId: string;
    receivedAt: string;
    payload: unknown;
    checksum: string;
  }): Promise<{ raw: StoredRaw; alreadyExisted: boolean }>;
  markRawStatus(id: string, status: "transformed" | "failed"): Promise<void>;
  recordError(input: {
    rawPayloadId: string;
    stage: string;
    code: string;
    message: string;
    at: string;
  }): Promise<void>;
  /** Kanonik kaydı yazar. Zaten varsa `false` döner (idempotency). */
  writeCanonical(rawId: string, value: unknown): Promise<boolean>;
  startRun(input: { source: string; kind: string; startedAt: string }): Promise<string>;
  finishRun(id: string, input: SyncSummary & { finishedAt: string; error?: string }): Promise<void>;
}

export interface SyncSummary {
  readonly status: "success" | "partial" | "failed";
  readonly fetched: number;
  readonly created: number;
  readonly skipped: number;
  readonly failed: number;
}

export interface SyncOptions {
  readonly window: FetchWindow;
  readonly now?: () => Date;
  /** Ağ hatasında kaç kez denensin. */
  readonly maxRetries?: number;
  /** Test edilebilirlik için bekleme fonksiyonu. */
  readonly sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function runSync<T>(
  adapter: IntegrationAdapter<T>,
  store: IntegrationStore,
  opts: SyncOptions,
): Promise<SyncSummary> {
  const now = opts.now ?? (() => new Date());
  const sleep = opts.sleep ?? defaultSleep;
  const maxRetries = opts.maxRetries ?? 3;

  const runId = await store.startRun({
    source: adapter.source,
    kind: adapter.kind,
    startedAt: now().toISOString(),
  });

  const fail = async (error: string): Promise<SyncSummary> => {
    const summary: SyncSummary = { status: "failed", fetched: 0, created: 0, skipped: 0, failed: 0 };
    await store.finishRun(runId, { ...summary, finishedAt: now().toISOString(), error });
    return summary;
  };

  // ── Bağlantı: auth hatası kalıcıdır, tekrar denenmez.
  try {
    await adapter.connect();
  } catch (e) {
    const err = e as IntegrationError;
    return fail(`Bağlantı başarısız (${err.classification ?? "unknown"}): ${err.message}`);
  }

  // ── Getirme: yalnızca ağ hatasında üstel geri çekilmeyle tekrar dene.
  let documents: readonly RawDocument[];
  try {
    documents = await withRetry(() => adapter.fetch(opts.window), maxRetries, sleep);
  } catch (e) {
    const err = e as IntegrationError;
    return fail(`Getirme başarısız (${err.classification ?? "unknown"}): ${err.message}`);
  }

  let created = 0;
  let skipped = 0;
  let failed = 0;

  for (const doc of documents) {
    const sum = checksum(doc.payload);

    // ── 1. HAM VERİ ÖNCE. Dönüşüm ne olursa olsun kanıt duruyor.
    const { raw, alreadyExisted } = await store.putRaw({
      source: adapter.source,
      kind: adapter.kind,
      externalId: doc.externalId,
      receivedAt: doc.receivedAt,
      payload: doc.payload,
      checksum: sum,
    });

    // ── 2. IDEMPOTENCY: aynı belge, aynı içerik → tekrar işlenmez.
    if (alreadyExisted && raw.checksum === sum && raw.status === "transformed") {
      skipped++;
      continue;
    }

    // ── 3. Dönüşüm. Saf fonksiyon; patlarsa yalnızca bu belge düşer.
    let result;
    try {
      result = adapter.normalize(doc);
    } catch (e) {
      result = { ok: false as const, code: "normalize_threw", message: (e as Error).message };
    }

    if (!result.ok) {
      failed++;
      await store.markRawStatus(raw.id, "failed");
      await store.recordError({
        rawPayloadId: raw.id,
        stage: "normalize",
        code: result.code,
        message: result.message,
        at: now().toISOString(),
      });
      continue; // BİR BELGE HATASI AKIŞI DURDURMAZ
    }

    // ── 4. Kanonik yazım.
    try {
      const written = await store.writeCanonical(raw.id, result.value);
      if (written) created++;
      else skipped++;
      await store.markRawStatus(raw.id, "transformed");
    } catch (e) {
      failed++;
      await store.markRawStatus(raw.id, "failed");
      await store.recordError({
        rawPayloadId: raw.id,
        stage: "canonical_write",
        code: "write_failed",
        message: (e as Error).message,
        at: now().toISOString(),
      });
    }
  }

  const summary: SyncSummary = {
    status: failed === 0 ? "success" : created > 0 || skipped > 0 ? "partial" : "failed",
    fetched: documents.length,
    created,
    skipped,
    failed,
  };
  await store.finishRun(runId, { ...summary, finishedAt: now().toISOString() });
  return summary;
}

/** Üstel geri çekilme — yalnızca `network` sınıfı hatalar için. */
async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number,
  sleep: (ms: number) => Promise<void>,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      const retryable = e instanceof IntegrationError && e.retryable;
      if (!retryable || attempt === maxRetries) throw e;
      await sleep(2 ** attempt * 250);
    }
  }
  throw lastError;
}
