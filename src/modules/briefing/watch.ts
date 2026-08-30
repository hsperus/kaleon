/**
 * Kullanıcı tanımlı izlemeler.
 *
 * NÖBETÇİLER KODA GÖMÜLÜYDÜ VE BEŞ TANEYDİ. 134 tool'un 5'i izleniyordu:
 * muhasebe, bordro, sabit kıymet, stok sayımı, bakım — hiçbiri. Yeni bir
 * izleme eklemek kod değişikliği, dağıtım ve test gerektiriyordu; bu
 * yüzden hiç eklenmedi. Oysa "neyi izlemek istediğini" en iyi bilen kişi
 * işletmenin sahibidir, yazılımı yazan değil.
 *
 * İZLEME VERİDİR: bir tool, bir alan, bir eşik ve bir cümle. Kullanıcı
 * "kasa 50 binin altına düşerse haber ver" der; sistem bunu kaydeder ve
 * her brifingde çalıştırır.
 *
 * ÜÇ GÜVENLİK KURALI:
 *
 *  1. YALNIZCA OKUMA TOOL'U İZLENİR (L0). Yazan bir tool'u izlemeye
 *     bağlamak, arka planda kendiliğinden çalışan bir yazma işlemi
 *     demektir — hiç kimsenin istemediği şey budur.
 *
 *  2. İZLEME SAHİBİNİN YETKİSİYLE KOŞAR, çağıranın değil. Depo
 *     sorumlusunun kurduğu bir izleme, patron ekranında da onun
 *     görebildiği veriyle çalışır; aksi hâlde izleme, yetki duvarında
 *     delik olurdu.
 *
 *  3. OKUNAMAYAN DEĞER SIFIR SAYILMAZ. Alan bulunamazsa izleme
 *     "değer okunamadı" der ve tetiklenmez; sıfır sayılsaydı "kasa
 *     sıfırın altına düştü" gibi sahte alarmlar üretirdi.
 */

import type { SignalLevel } from "./sentinels.js";

export type WatchOperator = "gt" | "gte" | "lt" | "lte" | "eq" | "neq" | "changed";

export interface WatchDefinition {
  readonly id: string;
  readonly name: string;
  /** İzlenecek okuma tool'u. */
  readonly tool: string;
  readonly input: unknown;
  /** Sonuç içindeki değerin yolu: "total", "rows[0].amount", "items.length". */
  readonly path: string;
  readonly operator: WatchOperator;
  /** Karşılaştırma eşiği; "changed" için kullanılmaz. */
  readonly threshold: number | null;
  readonly level: SignalLevel;
  /** Tetiklendiğinde gösterilecek cümle. {deger} ve {esik} yerine konur. */
  readonly message: string;
  /** Son görülen değer — "changed" karşılaştırması için. */
  readonly lastValue: number | null;
}

export class WatchError extends Error {
  readonly code = "watch";
  constructor(message: string) {
    super(message);
    this.name = "WatchError";
  }
}

/**
 * Sonuçtan değeri okur.
 *
 * BULUNAMAYAN YOL `null` DÖNER, hata fırlatmaz: tool'un çıktısı bir gün
 * değişirse izleme sessizce yanlış tetiklenmek yerine "okunamadı" der.
 */
export function readPath(data: unknown, path: string): number | null {
  const parts = path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter((p) => p.length > 0);

  let cur: unknown = data;
  for (const part of parts) {
    if (cur === null || cur === undefined) return null;

    // Dizi uzunluğu sık kullanılan bir izleme hedefidir:
    // "bekleyen onay sayısı 5'i geçerse".
    if (part === "length" && Array.isArray(cur)) {
      cur = cur.length;
      continue;
    }

    if (Array.isArray(cur)) {
      const i = Number(part);
      if (!Number.isInteger(i) || i < 0 || i >= cur.length) return null;
      cur = cur[i];
      continue;
    }

    if (typeof cur !== "object") return null;
    cur = (cur as Record<string, unknown>)[part];
  }

  if (typeof cur === "number" && Number.isFinite(cur)) return cur;
  // Boolean da izlenebilir: "denk mi" gibi alanlar 1/0 olarak okunur.
  if (typeof cur === "boolean") return cur ? 1 : 0;
  return null;
}

/**
 * Sonuçtaki sayısal alanların yolları.
 *
 * KULLANICI ALAN ADINI BİLMEK ZORUNDA DEĞİLDİR. "Kasa 500 binin
 * altına düşerse haber ver" diyen kişi `balances[0].available` gibi
 * bir yol yazmaz; yazsa bile yanlış yazar ve izleme sessizce ölür.
 * İzleme kurulurken tool bir kez çalıştırılır ve okunabilir yollar
 * çıkarılır; yanlış yol verilmişse doğruları söylenir.
 *
 * Dizilerde YALNIZCA İLK ELEMAN gezilir ve `length` eklenir: 200
 * satırlık bir sonuçta 200 yol üretmek listeyi kullanılamaz kılardı.
 */
export function numericPaths(data: unknown, prefix = "", depth = 0): readonly string[] {
  if (depth > 3 || data === null || data === undefined) return [];

  if (typeof data === "number" || typeof data === "boolean") {
    return prefix ? [prefix] : [];
  }

  if (Array.isArray(data)) {
    const out = [prefix ? `${prefix}.length` : "length"];
    if (data.length > 0) {
      out.push(...numericPaths(data[0], `${prefix}[0]`, depth + 1));
    }
    return out;
  }

  if (typeof data === "object") {
    const out: string[] = [];
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      out.push(...numericPaths(v, prefix ? `${prefix}.${k}` : k, depth + 1));
      // Uzun listeler yardımcı olmaz; ilk 40 yol yeter.
      if (out.length > 40) break;
    }
    return out;
  }

  return [];
}

export interface WatchOutcome {
  /** Okunan değer; okunamadıysa null. */
  readonly value: number | null;
  readonly fired: boolean;
  /** Tetiklenmediyse ya da okunamadıysa sebep. */
  readonly reason: string | null;
}

/** Şablondaki yer tutucuları doldurur. */
export function renderMessage(
  template: string,
  value: number | null,
  threshold: number | null,
): string {
  const fmt = (n: number | null): string =>
    n === null ? "bilinmiyor" : n.toLocaleString("tr-TR");
  return template
    .replace(/\{deger\}/g, fmt(value))
    .replace(/\{esik\}/g, fmt(threshold));
}

/** İzlemeyi bir tool sonucuna karşı değerlendirir. */
export function evaluateWatch(w: WatchDefinition, data: unknown): WatchOutcome {
  const value = readPath(data, w.path);

  if (value === null) {
    // OKUNAMAYAN DEĞER SAHTE ALARM ÜRETMEZ.
    return {
      value: null,
      fired: false,
      reason: `"${w.path}" alanı ${w.tool} sonucunda bulunamadı; izleme çalışmadı.`,
    };
  }

  if (w.operator === "changed") {
    // İlk koşuda "değişti" denemez: karşılaştırılacak bir önceki değer yok.
    if (w.lastValue === null) {
      return { value, fired: false, reason: "İlk ölçüm; karşılaştırma sonraki koşuda." };
    }
    const changed = value !== w.lastValue;
    return {
      value,
      fired: changed,
      reason: changed ? null : "Değer değişmedi.",
    };
  }

  if (w.threshold === null) {
    return { value, fired: false, reason: "Eşik tanımlı değil; izleme çalışmadı." };
  }

  const t = w.threshold;
  const fired =
    w.operator === "gt" ? value > t
    : w.operator === "gte" ? value >= t
    : w.operator === "lt" ? value < t
    : w.operator === "lte" ? value <= t
    : w.operator === "eq" ? value === t
    : value !== t;

  return { value, fired, reason: fired ? null : "Eşik aşılmadı." };
}

const OPERATOR_LABEL: Record<WatchOperator, string> = {
  gt: "büyükse",
  gte: "büyük veya eşitse",
  lt: "küçükse",
  lte: "küçük veya eşitse",
  eq: "eşitse",
  neq: "eşit değilse",
  changed: "değişirse",
};

/** İzlemenin insan okunur tanımı — listede ve onay formunda görünür. */
export function describeWatch(w: WatchDefinition): string {
  if (w.operator === "changed") return `${w.name}: ${w.path} değişirse`;
  return `${w.name}: ${w.path} değeri ${w.threshold?.toLocaleString("tr-TR")} ${OPERATOR_LABEL[w.operator]}`;
}
