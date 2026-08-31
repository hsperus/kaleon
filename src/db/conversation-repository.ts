/**
 * Konuşma deposu — Postgres adaptörü.
 *
 * SIRA NUMARASI ZAMANA DEĞİL SAYACA DAYANIR.
 * `created_at` ile sıralamak iki mesaj aynı milisaniyede yazıldığında
 * belirsiz sonuç verir; konuşma sırası bozulursa model soruyu cevabın
 * ardından görür ve saçmalar. `seq` + unique kısıt bunu imkânsız kılar:
 * eşzamanlı iki yazımdan biri hata alır, ikisi de aynı sıraya oturamaz.
 */

import { excerptAround } from "../modules/conversation/repository.js";
import { Prisma } from "./generated/tenant/index.js";
import type { TenantDb } from "./client.js";
import type { ConversationTurn } from "../ai/runner.js";
import type {
  ConversationRepository,
  ConversationSummary,
} from "../modules/conversation/repository.js";

export class PrismaConversationRepository implements ConversationRepository {
  readonly #db: TenantDb;

  constructor(db: TenantDb) {
    this.#db = db;
  }

  async create(userId: string, title: string): Promise<string> {
    const row = await this.#db.conversation.create({ data: { userId, title } });
    return row.id;
  }

  async history(
    conversationId: string,
    userId: string,
  ): Promise<readonly ConversationTurn[] | null> {
    // SAHİPLİK SORGUNUN İÇİNDE. Önce oku sonra kontrol et yaklaşımı, bir
    // gün kontrolü atlayan bir kod yolu doğurur; koşul buraya yazılırsa
    // yanlış kullanıcıya veri dönmesi mümkün olmaz.
    const conv = await this.#db.conversation.findFirst({
      where: { id: conversationId, userId },
      include: { messages: { orderBy: { seq: "asc" } } },
    });
    if (!conv) return null;

    const turns: ConversationTurn[] = [];
    for (let i = 0; i < conv.messages.length; i++) {
      const m = conv.messages[i]!;
      if (m.role !== "user") continue;
      const next = conv.messages[i + 1];
      // Cevabı olmayan soru geçmişe konmaz: modele yarım bir tur göstermek,
      // kendi cevabını uydurmasına davetiye çıkarır.
      if (next?.role === "assistant") {
        turns.push({ question: m.content, answer: next.content });
      }
    }
    return turns;
  }

  async appendTurn(conversationId: string, turn: ConversationTurn): Promise<void> {
    // Sıra numarası ve iki mesaj TEK transaction'da yazılır: soru yazılıp
    // cevap yazılamazsa geçmişte cevapsız bir soru kalırdı.
    await this.#db.$transaction(async (tx) => {
      const last = await tx.conversationMessage.findFirst({
        where: { conversationId },
        orderBy: { seq: "desc" },
        select: { seq: true },
      });
      const base = (last?.seq ?? -1) + 1;

      await tx.conversationMessage.createMany({
        data: [
          { conversationId, seq: base, role: "user", content: turn.question },
          { conversationId, seq: base + 1, role: "assistant", content: turn.answer },
        ],
      });
      await tx.conversation.update({
        where: { id: conversationId },
        data: { updatedAt: new Date() },
      });
    });
  }

  async list(userId: string, limit = 30): Promise<readonly ConversationSummary[]> {
    const rows = await this.#db.conversation.findMany({
      where: { userId },
      orderBy: { updatedAt: "desc" },
      take: Math.min(limit, 100),
      select: { id: true, title: true, updatedAt: true },
    });
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      updatedAt: r.updatedAt.toISOString(),
    }));
  }

  /**
   * Konuşmalarda arama.
   *
   * BAŞLIKTA VE MESAJ İÇERİĞİNDE arar. Yalnızca başlığa bakmak
   * neredeyse işe yaramaz: başlık ilk sorudan türetiliyor ve aranan
   * şey çoğu zaman konuşmanın ortasında geçiyor — "hangi konuşmada
   * Daimler'den bahsetmiştim" sorusu başlıkla cevaplanamaz.
   *
   * SAHİPLİK KOŞULU SORGUNUN İÇİNDE. Sonradan filtrelemek, bir hata
   * durumunda başkasının konuşmasını sızdırırdı.
   *
   * EŞLEŞEN PARÇA DA DÖNER: kullanıcı neden eşleştiğini görmeli,
   * yoksa liste rastgele görünür.
   */
  async search(
    userId: string,
    query: string,
    limit = 20,
  ): Promise<readonly (ConversationSummary & { snippet: string | null })[]> {
    const q = query.trim();
    if (q.length < 2) return [];

    const rows = await this.#db.conversation.findMany({
      where: {
        userId,
        OR: [
          { title: { contains: q, mode: "insensitive" } },
          { messages: { some: { content: { contains: q, mode: "insensitive" } } } },
        ],
      },
      orderBy: { updatedAt: "desc" },
      take: Math.min(limit, 50),
      select: {
        id: true,
        title: true,
        updatedAt: true,
        messages: {
          where: { content: { contains: q, mode: "insensitive" } },
          orderBy: { seq: "asc" },
          take: 1,
          select: { content: true },
        },
      },
    });

    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      updatedAt: r.updatedAt.toISOString(),
      snippet: r.messages[0] ? excerptAround(r.messages[0].content, q) : null,
    }));
  }

  /**
   * Başlığı değiştirir.
   *
   * SAHİPLİK KOŞULU GÜNCELLEME SORGUSUNUN İÇİNDE — `updateMany` ile.
   * Önce okuyup sonra yazmak, iki sorgu arasında sahiplik değişirse
   * (pratikte olmaz ama) yarış açar; tek sorguda koşul atomiktir.
   *
   * `updatedAt` BİLEREK DOKUNULMUYOR: yeniden adlandırma konuşmayı
   * listenin başına taşımamalı. Sıralama son KONUŞMA zamanına göre;
   * başlığı düzeltmek konuşmayı tazelemez.
   */
  async rename(conversationId: string, userId: string, title: string): Promise<boolean> {
    const r = await this.#db.conversation.updateMany({
      where: { id: conversationId, userId },
      data: { title },
    });
    return r.count > 0;
  }

  async remove(conversationId: string, userId: string): Promise<boolean> {
    try {
      // Sahiplik koşulu silme sorgusunun içinde: başkasının konuşması,
      // kimliği ele geçse bile silinemez.
      const r = await this.#db.conversation.deleteMany({
        where: { id: conversationId, userId },
      });
      return r.count > 0;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") return false;
      throw e;
    }
  }
}

