/**
 * Konuşma deposu — Postgres adaptörü.
 *
 * SIRA NUMARASI ZAMANA DEĞİL SAYACA DAYANIR.
 * `created_at` ile sıralamak iki mesaj aynı milisaniyede yazıldığında
 * belirsiz sonuç verir; konuşma sırası bozulursa model soruyu cevabın
 * ardından görür ve saçmalar. `seq` + unique kısıt bunu imkânsız kılar:
 * eşzamanlı iki yazımdan biri hata alır, ikisi de aynı sıraya oturamaz.
 */

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
