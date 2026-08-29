/**
 * Kaynak (IP) bazlı sabit pencere sınırlayıcı.
 *
 * NEDEN HESAP KİLİDİNE EK OLARAK:
 * Hesap kilidi tek bir hesaba yapılan denemeyi durdurur. Bir saldırgan
 * BİR parolayı BİN hesapta dener (password spraying) — her hesap için tek
 * deneme, hiçbir kilit açılmaz. IP sınırı bu deseni yakalar.
 *
 * NEDEN YALNIZCA SÜREÇ İÇİ:
 * Sayaç bellektedir; çok düğümlü kurulumda her düğüm kendi sayacını tutar
 * ve etkin sınır düğüm sayısıyla çarpılır. Redis'li dağıtık sürüm ayrı iş.
 * Süreç içi sürüm test edilebilir ve tek düğümde gerçek koruma sağlar;
 * bu yüzden yazıldı, ama sınırı burada YAZILI (BUILD-PLAN değişmez #9).
 */

export interface ThrottleDecision {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly retryAfterMs: number;
}

export class FixedWindowThrottle {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #buckets = new Map<string, { count: number; resetAt: number }>();

  constructor(opts: { limit: number; windowMs: number; now?: () => number }) {
    this.#limit = opts.limit;
    this.#windowMs = opts.windowMs;
    this.#now = opts.now ?? (() => Date.now());
  }

  check(key: string): ThrottleDecision {
    const t = this.#now();
    const bucket = this.#buckets.get(key);

    if (!bucket || bucket.resetAt <= t) {
      this.#buckets.set(key, { count: 1, resetAt: t + this.#windowMs });
      this.#sweep(t);
      return { allowed: true, remaining: this.#limit - 1, retryAfterMs: 0 };
    }

    if (bucket.count >= this.#limit) {
      return { allowed: false, remaining: 0, retryAfterMs: bucket.resetAt - t };
    }

    bucket.count += 1;
    return { allowed: true, remaining: this.#limit - bucket.count, retryAfterMs: 0 };
  }

  /**
   * Süresi dolmuş kovaları temizler. Olmasaydı harita sınırsız büyürdü —
   * her yeni IP kalıcı bir kayıt bırakır ve bu bir bellek sızıntısıdır.
   */
  #sweep(t: number): void {
    if (this.#buckets.size < 1000) return;
    for (const [k, v] of this.#buckets) {
      if (v.resetAt <= t) this.#buckets.delete(k);
    }
  }

  get size(): number {
    return this.#buckets.size;
  }
}

/** Giriş uç noktası için: 10 deneme / 5 dakika / IP. */
export const LOGIN_THROTTLE = { limit: 10, windowMs: 5 * 60 * 1000 } as const;
