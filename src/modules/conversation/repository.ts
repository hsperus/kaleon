/**
 * Konuşma deposu.
 *
 * ÜÇ KARAR:
 *
 *  1. YALNIZCA METİN SAKLANIR. Tool çağrıları ve sonuçları kaydedilmez.
 *     Dünkü banka bakiyesi bugünkü cevaba karışırsa sistem yanlış rakam
 *     söyler ve nereden geldiği anlaşılmaz. Model bilgiye yine ihtiyaç
 *     duyarsa tool'u tekrar çağırıp GÜNCELİNİ alır.
 *
 *  2. SAHİPLİK HER OKUMADA DOĞRULANIR. Konuşma kimliği tahmin edilebilir
 *     olmasa bile, "kimliği bilen okuyabilir" bir yetkilendirme değildir.
 *     Başkasının konuşması, kimliği ele geçse dahi açılmaz.
 *
 *  3. GEÇMİŞ SINIRLI TAŞINIR. Modele son N tur gider. Sınırsız geçmiş,
 *     her turda katlanan maliyet ve gecikme demektir; ayrıca çok eski
 *     bağlam cevabı iyileştirmez, bulandırır.
 */

import type { ConversationTurn } from "../../ai/runner.js";

/** Modele taşınacak en fazla tur. */
export const MAX_HISTORY_TURNS = 12;

export interface ConversationSummary {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: string;
}

/** Arama sonucu: eşleşen konuşma ve eşleşmenin çevresinden bir alıntı. */
export interface ConversationHit extends ConversationSummary {
  /** Eşleşme yalnızca başlıktaysa null. */
  readonly snippet: string | null;
}

export interface ConversationRepository {
  /** Yeni konuşma açar ve kimliğini döndürür. */
  create(userId: string, title: string): Promise<string>;
  /** Sahibi doğrulanmış geçmiş. Sahip değilse null. */
  history(conversationId: string, userId: string): Promise<readonly ConversationTurn[] | null>;
  /** Bir turu (soru + cevap) sonuna ekler. */
  appendTurn(conversationId: string, turn: ConversationTurn): Promise<void>;
  /** Kullanıcının konuşmaları, en yeniden eskiye. */
  list(userId: string, limit?: number): Promise<readonly ConversationSummary[]>;
  /**
   * Başlıkta VE mesaj içeriğinde arar.
   *
   * Yalnızca başlığa bakmak neredeyse işe yaramaz: başlık ilk sorudan
   * türetiliyor ve aranan şey çoğu zaman konuşmanın ortasında geçiyor.
   */
  search(userId: string, query: string, limit?: number): Promise<readonly ConversationHit[]>;
  /** Sahibi doğrulanmış silme. */
  remove(conversationId: string, userId: string): Promise<boolean>;
}

/**
 * Eşleşmenin çevresinden kısa bir alıntı.
 *
 * Baştan kesmek işe yaramaz: aranan kelime 900. karakterdeyse
 * kullanıcı neden eşleştiğini göremez. Eşleşmenin ETRAFINDAN kesilir.
 */
export function excerptAround(content: string, query: string, radius = 60): string {
  const flat = content.replace(/\s+/g, " ").trim();
  const i = flat.toLocaleLowerCase("tr").indexOf(query.toLocaleLowerCase("tr"));
  if (i < 0) return flat.slice(0, radius * 2);

  const bas = Math.max(0, i - radius);
  const son = Math.min(flat.length, i + query.length + radius);
  return (bas > 0 ? "…" : "") + flat.slice(bas, son) + (son < flat.length ? "…" : "");
}

/**
 * Konuşma başlığı ilk sorudan üretilir.
 *
 * Modele başlık yazdırmak fazladan bir çağrı ve fazladan maliyet demektir;
 * ilk soru, kullanıcının o konuşmayı hatırlaması için zaten yeterli.
 */
export function titleFrom(question: string): string {
  const clean = question.replace(/\s+/g, " ").trim();
  if (clean.length <= 60) return clean || "Yeni konuşma";
  // Kelimenin ortasından kesmek başlığı okunmaz yapar.
  const cut = clean.slice(0, 60);
  const lastSpace = cut.lastIndexOf(" ");
  return `${lastSpace > 30 ? cut.slice(0, lastSpace) : cut}…`;
}

/** Son N turu alır — geçmişin başı değil SONU taşınır. */
export function recentTurns(
  turns: readonly ConversationTurn[],
  max = MAX_HISTORY_TURNS,
): readonly ConversationTurn[] {
  return turns.length <= max ? turns : turns.slice(turns.length - max);
}

/** Bellek içi uygulama — test ve demo için. */
export class InMemoryConversationRepository implements ConversationRepository {
  #seq = 0;
  readonly #conversations = new Map<
    string,
    { userId: string; title: string; updatedAt: string; turns: ConversationTurn[] }
  >();

  async create(userId: string, title: string): Promise<string> {
    const id = `conv-${++this.#seq}`;
    this.#conversations.set(id, {
      userId,
      title,
      updatedAt: new Date().toISOString(),
      turns: [],
    });
    return id;
  }

  async history(conversationId: string, userId: string): Promise<readonly ConversationTurn[] | null> {
    const c = this.#conversations.get(conversationId);
    if (!c || c.userId !== userId) return null;
    return c.turns;
  }

  async appendTurn(conversationId: string, turn: ConversationTurn): Promise<void> {
    const c = this.#conversations.get(conversationId);
    if (!c) throw new Error(`Konuşma yok: ${conversationId}`);
    c.turns.push(turn);
    c.updatedAt = new Date().toISOString();
  }

  async list(userId: string, limit = 30): Promise<readonly ConversationSummary[]> {
    return [...this.#conversations.entries()]
      .filter(([, c]) => c.userId === userId)
      .map(([id, c]) => ({ id, title: c.title, updatedAt: c.updatedAt }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit);
  }

  async search(userId: string, query: string, limit = 20): Promise<readonly ConversationHit[]> {
    const q = query.trim().toLocaleLowerCase("tr");
    if (q.length < 2) return [];

    const hits: ConversationHit[] = [];
    for (const [id, c] of this.#conversations) {
      if (c.userId !== userId) continue;

      const basliktaVar = c.title.toLocaleLowerCase("tr").includes(q);
      // Soru VE cevap birlikte aranır: kullanıcı kendi yazdığını da,
      // aldığı cevabı da hatırlayabilir.
      const tur = c.turns.find(
        (t) =>
          t.question.toLocaleLowerCase("tr").includes(q) ||
          t.answer.toLocaleLowerCase("tr").includes(q),
      );
      if (!basliktaVar && !tur) continue;

      const kaynak = tur
        ? tur.question.toLocaleLowerCase("tr").includes(q)
          ? tur.question
          : tur.answer
        : null;
      hits.push({
        id,
        title: c.title,
        updatedAt: c.updatedAt,
        snippet: kaynak ? excerptAround(kaynak, query) : null,
      });
    }

    return hits.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit);
  }

  async remove(conversationId: string, userId: string): Promise<boolean> {
    const c = this.#conversations.get(conversationId);
    if (!c || c.userId !== userId) return false;
    this.#conversations.delete(conversationId);
    return true;
  }
}
