/**
 * Süreç genelinde paylaşılan tekil değerler.
 *
 * NEXT.JS HER ROUTE'U AYRI PAKETLER. `app/api/ask` ile `app/api/health`
 * aynı dosyayı import etse bile, o dosyanın modül seviyesindeki değişkeni
 * İKİ AYRI KOPYA olabilir. Sonuç sinsi: bir route'ta yazılan durum
 * diğerinde görünmez, ama kod okununca paylaşılıyormuş gibi durur.
 *
 * Pratik zararı somut: demo modunda onay bekleyen işlem `/api/ask` içinde
 * oluşur, `/api/trpc` içinde onaylanır. İki route farklı kopya görürse
 * kullanıcı "onayla"ya basar ve "işlem bulunamadı" cevabı alır — hiçbir
 * hata mesajı da nedenini söylemez.
 *
 * `globalThis` süreçte tektir; paketleme sınırlarını aşar.
 */

const SLOT = Symbol.for("kaelon.singletons");

interface Slot {
  readonly values: Map<string, unknown>;
}

function slot(): Slot {
  const g = globalThis as unknown as Record<symbol, Slot | undefined>;
  g[SLOT] ??= { values: new Map() };
  return g[SLOT]!;
}

/**
 * Anahtara karşılık gelen tekil değeri döndürür; yoksa `create` ile kurar.
 *
 * Anahtar SABİT VE AÇIK olmalıdır: dinamik bir anahtar (örneğin dosya
 * yolu) paketleyiciye göre değişir ve tekilliği yeniden bozar.
 */
export function singleton<T>(key: string, create: () => T): T {
  const s = slot();
  if (!s.values.has(key)) s.values.set(key, create());
  return s.values.get(key) as T;
}

/** Değiştirilebilir tekil kutu — okuma ve yazma ayrı yerlerde olabilir. */
export function box<T>(key: string, initial: T): { get(): T; set(v: T): void } {
  const holder = singleton(`box:${key}`, () => ({ value: initial }));
  return {
    get: () => holder.value,
    set: (v: T) => {
      holder.value = v;
    },
  };
}
