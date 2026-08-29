/**
 * Sorgu satır sınırları.
 *
 * SINIRSIZ SORGU BİR ZAMAN BOMBASIDIR. Geliştirmede 20 satır döner, pilotta
 * 500, ikinci yılda 400.000 — ve o gün sunucu belleği tükenir. Sınır,
 * tablonun büyüyeceğini kabul etmektir.
 *
 * SINIRA TAKILMAK SESSİZ KALMAZ: sınıra dayanan bir sorgu, cevabın eksik
 * olduğunu `caveat` ile söyler. "İlk 5000 kayda bakıldı" demek, hiç
 * söylememekten iyidir — kullanıcı sonucun tamam olmadığını bilmeli.
 */

/** Tek sorguda belleğe alınacak en fazla satır. */
export const MAX_ROWS = 5_000;

/** Kullanıcıya listelenecek en fazla satır (arayüz sınırı). */
export const MAX_LIST_ROWS = 200;

/**
 * Sonuç sınıra dayandıysa uyarı üretir.
 * `null` dönerse sınıra dayanılmamıştır ve söylenecek bir şey yoktur.
 */
export function limitCaveat(rowCount: number, what: string, limit = MAX_ROWS): string | null {
  if (rowCount < limit) return null;
  return `${what} için en fazla ${limit.toLocaleString("tr-TR")} kayda bakıldı; sonuç eksik olabilir.`;
}
