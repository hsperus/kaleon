/**
 * İş zamanlayıcı portu.
 *
 * NEDEN PORT, NEDEN DOĞRUDAN BullMQ DEĞİL:
 * BullMQ Redis'e bağlıdır. Zamanlama mantığı — periyot, çakışma önleme,
 * hata yalıtımı, geri çekilme — Redis'ten bağımsızdır ve test edilebilir
 * olmalıdır. Port bu ayrımı verir: mantık burada ve testli, taşıma katmanı
 * adaptörde.
 *
 * `InProcessScheduler` geliştirme ve tek düğümlü kurulum için yeterlidir.
 * Çok düğümlü üretimde BullMQ adaptörü aynı arayüzü uygular; tek fark
 * kilidin süreç içi değil Redis'te tutulmasıdır (bkz. dosya sonu).
 *
 * ÇAKIŞMA ÖNLEME BİR ZORUNLULUKTUR, İYİLEŞTİRME DEĞİL:
 * 15 dakikada bir çalışan bir e-fatura senkronu 20 dakika sürerse, ikinci
 * koşu birincisi biterken başlar. İki koşu aynı belgeleri aynı anda işler;
 * idempotency kısıtı veriyi kurtarır ama loglar ve sayaçlar anlamsızlaşır.
 * Zamanlayıcı, bir iş koşarken aynısını başlatmaz.
 */

export interface JobRun {
  readonly name: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly ok: boolean;
  readonly error?: string;
  readonly durationMs: number;
}

export interface JobDefinition {
  readonly name: string;
  /** Milisaniye cinsinden periyot. */
  readonly everyMs: number;
  readonly run: () => Promise<void>;
  /** Hata sonrası ilk yeniden deneme gecikmesi. */
  readonly retryDelayMs?: number;
  readonly maxRetries?: number;
}

export interface JobScheduler {
  register(job: JobDefinition): void;
  start(): void;
  stop(): void;
  /** Bir işi hemen çalıştırır (elle tetikleme / test). */
  runNow(name: string): Promise<JobRun>;
  readonly history: readonly JobRun[];
}

export class InProcessScheduler implements JobScheduler {
  readonly #jobs = new Map<string, JobDefinition>();
  readonly #timers = new Map<string, ReturnType<typeof setInterval>>();
  readonly #running = new Set<string>();
  readonly #history: JobRun[] = [];
  readonly #now: () => Date;
  readonly #sleep: (ms: number) => Promise<void>;
  #started = false;

  constructor(opts?: { now?: () => Date; sleep?: (ms: number) => Promise<void> }) {
    this.#now = opts?.now ?? (() => new Date());
    this.#sleep = opts?.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  get history(): readonly JobRun[] {
    return this.#history;
  }

  register(job: JobDefinition): void {
    if (this.#jobs.has(job.name)) {
      throw new Error(`İş adı çakışması: ${job.name}`);
    }
    this.#jobs.set(job.name, job);
    if (this.#started) this.#schedule(job);
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    for (const job of this.#jobs.values()) this.#schedule(job);
  }

  stop(): void {
    this.#started = false;
    for (const t of this.#timers.values()) clearInterval(t);
    this.#timers.clear();
  }

  #schedule(job: JobDefinition): void {
    const timer = setInterval(() => {
      void this.runNow(job.name).catch(() => undefined);
    }, job.everyMs);
    // Node'da zamanlayıcı süreci canlı tutmasın.
    (timer as unknown as { unref?: () => void }).unref?.();
    this.#timers.set(job.name, timer);
  }

  async runNow(name: string): Promise<JobRun> {
    const job = this.#jobs.get(name);
    if (!job) throw new Error(`Tanımsız iş: ${name}`);

    // ÇAKIŞMA ÖNLEME: aynı iş zaten koşuyorsa ikincisi başlatılmaz.
    if (this.#running.has(name)) {
      const run: JobRun = {
        name,
        startedAt: this.#now().toISOString(),
        finishedAt: this.#now().toISOString(),
        ok: false,
        error: "önceki koşu hâlâ devam ediyor; atlandı",
        durationMs: 0,
      };
      this.#history.push(run);
      return run;
    }

    this.#running.add(name);
    const startedAt = this.#now();
    const t0 = Date.now();
    const maxRetries = job.maxRetries ?? 0;
    let lastError: unknown = null;

    try {
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          await job.run();
          lastError = null;
          break;
        } catch (e) {
          lastError = e;
          if (attempt < maxRetries) {
            await this.#sleep((job.retryDelayMs ?? 1000) * 2 ** attempt);
          }
        }
      }
    } finally {
      this.#running.delete(name);
    }

    const run: JobRun = {
      name,
      startedAt: startedAt.toISOString(),
      finishedAt: this.#now().toISOString(),
      ok: lastError === null,
      durationMs: Date.now() - t0,
      ...(lastError ? { error: (lastError as Error).message } : {}),
    };
    this.#history.push(run);
    return run;
  }
}

/**
 * Üretim senkron takvimi.
 *
 * Periyotlar Mimari v1 §8.2'den: e-Fatura 15 dk, banka saatlik.
 * Sıklık veri değerinden değil, verinin DEĞİŞME hızından türer —
 * banka bakiyesi gün içinde birkaç kez değişir, e-fatura sürekli akar.
 */
export const SYNC_SCHEDULE = {
  einvoice: 15 * 60 * 1000,
  bank: 60 * 60 * 1000,
  attendance: 6 * 60 * 60 * 1000,
} as const;

/**
 * BullMQ adaptörü için not (henüz yazılmadı, bilinçli):
 *
 * Aynı `JobScheduler` arayüzünü uygular. Tek yapısal fark, çakışma
 * önlemenin süreç içi `Set` yerine Redis kilidiyle yapılmasıdır — çok
 * düğümlü kurulumda iki sunucu aynı işi aynı anda başlatabilir ve süreç
 * içi kilit bunu göremez. Redis kurulu bir ortam olmadan bu adaptörü
 * yazmak, test edilemeyen kod üretmek olurdu; port hazır, adaptör
 * altyapı geldiğinde eklenecek.
 */
