/**
 * Konuşma hafızası tool'ları.
 *
 * ÖLÇÜLEN DAVRANIŞ: "geçen ay konuştuğumuz gibi" dendiğinde ajan
 * geçen ayı hatırlamıyordu. Konuşma geçmişi SAKLANIYORDU ve arama
 * VARDI — ama yalnızca arayüzün kenar çubuğu için. Ajanın o aramaya
 * hiçbir erişimi yoktu.
 *
 * Yani hafıza diskteydi, modelin elinde değildi.
 *
 * ─────────────────────────────────────────────────────────────────
 *
 * GEÇMİŞ CEVAP BİR KAYNAK DEĞİL, BİR HATIRLATMADIR.
 *
 * En tehlikeli kullanım şu olurdu: model geçen ayki bir cevaptaki
 * rakamı bulup bugünkü soruya cevap olarak vermek. O rakam o günün
 * verisinden üretildi ve bugün yanlış olabilir — stok değişti,
 * fatura kesildi, kur oynadı.
 *
 * Bu yüzden her sonuç, tarihiyle birlikte ve AÇIK bir uyarıyla
 * dönüyor: geçmişte ne konuşulduğunu söyler, bugün ne olduğunu
 * söylemez. Bugünü öğrenmek için ilgili tool yeniden çağrılmalı.
 *
 * SAHİPLİK ZATEN DEPODA. `search` ve `history` kullanıcı kimliğiyle
 * çalışıyor; başkasının konuşması hiçbir yoldan görünmüyor.
 */

import { z } from "zod";
import { defineTool } from "../../kernel/tool.js";
import { MAX_HISTORY_TURNS, type ConversationRepository } from "./repository.js";

function kaynak(n: number) {
  return {
    system: "Konuşma geçmişi",
    kind: "module" as const,
    recordCount: n,
    syncedAt: new Date().toISOString(),
  };
}

/** Kaç gün önce — "geçen ay" ifadesini somutlaştırır. */
function gunOnce(iso: string, now: Date): number {
  return Math.floor((now.getTime() - new Date(iso).getTime()) / 86_400_000);
}

const TAZELIK_UYARISI =
  "Bu sonuçlar GEÇMİŞTE NE KONUŞULDUĞUNU söyler, bugün ne olduğunu değil. " +
  "İçindeki rakamlar o günün verisinden üretildi ve bugün değişmiş olabilir; " +
  "güncel rakam için ilgili tool'u yeniden çağır.";

export function memoryTools(repo: ConversationRepository) {
  const search = defineTool({
    name: "search_conversations",
    module: "briefing",
    authority: 0,
    description: {
      tr:
        "Kullanıcının GEÇMİŞ konuşmalarında arar: başlıkta ve mesaj içeriğinde. " +
        "'Geçen ay konuştuğumuz gibi', 'daha önce sormuştum', 'bunu ne zaman " +
        "konuşmuştuk' gibi geçmişe atıf yapan isteklerde kullan. Sonuçlar " +
        "eşleşmenin çevresinden bir alıntı ve tarih içerir. GEÇMİŞTEKİ RAKAMLAR " +
        "GÜNCEL DEĞİLDİR — ne konuşulduğunu öğrenmek için kullan, bugünkü değeri " +
        "öğrenmek için ilgili tool'u ayrıca çağır.",
      en: "Searches the user's past conversations by title and message content.",
    },
    input: z.strictObject({
      query: z
        .string()
        .trim()
        .min(2)
        .max(120)
        .describe("Aranacak kelime ya da ifade. Kullanıcının kendi kelimesini kullan."),
      limit: z.number().int().positive().max(20).describe("Kaç konuşma döndürülsün. Genelde 5."),
    }),
    requires: ["briefing:watch.read"],
    async execute(input, ctx) {
      const hits = await repo.search(ctx.principal.userId, input.query, input.limit);
      const bugun = ctx.now();

      const rows = hits.map((h) => ({
        conversationId: h.id,
        title: h.title,
        updatedAt: h.updatedAt.slice(0, 10),
        daysAgo: gunOnce(h.updatedAt, bugun),
        snippet: h.snippet,
      }));

      return {
        ok: true as const,
        data: {
          query: input.query,
          total: rows.length,
          message:
            rows.length === 0
              ? `"${input.query}" ile eşleşen geçmiş konuşma yok.`
              : "",
          conversations: rows,
        },
        sources: [kaynak(rows.length)],
        risks:
          rows.length === 0
            ? []
            : [
                {
                  severity: "info" as const,
                  message:
                    `${rows.length} geçmiş konuşma bulundu; en yenisi ${rows[0]!.daysAgo} ` +
                    `gün önce. ${TAZELIK_UYARISI}`,
                },
              ],
        confidence: 94,
      };
    },
  });

  const read = defineTool({
    name: "get_past_conversation",
    module: "briefing",
    authority: 0,
    description: {
      tr:
        "Geçmiş bir konuşmanın soru–cevap akışını döndürür. Önce " +
        "search_conversations ile konuşmayı bul, sonra bunu çağır. Uzun " +
        "konuşmalarda yalnızca SON turlar döner — bir konuşmanın tamamını " +
        "okumak, bugünkü soruyu cevaplamaya nadiren yardım eder. GEÇMİŞTEKİ " +
        "RAKAMLAR GÜNCEL DEĞİLDİR.",
      en: "Returns the question/answer turns of a past conversation.",
    },
    input: z.strictObject({
      conversationId: z.string().min(1).max(64).describe("Konuşma kimliği (search_conversations'dan)."),
      maxTurns: z
        .number()
        .int()
        .positive()
        .max(MAX_HISTORY_TURNS)
        .describe(`Kaç tur döndürülsün, en fazla ${MAX_HISTORY_TURNS}. Genelde 4.`),
    }),
    requires: ["briefing:watch.read"],
    async execute(input, ctx) {
      /*
       * SAHİPLİK DEPODA DOĞRULANIYOR.
       *
       * `history` kullanıcı kimliğini alıyor ve sahibi değilse null
       * dönüyor. Burada ayrıca kontrol etmek, iki yerde bakım
       * gerektiren tek bir kural yaratırdı — ve o kuralın biri
       * güncellenip diğeri unutulurdu.
       */
      const turns = await repo.history(input.conversationId, ctx.principal.userId);

      /*
       * SON TURLAR ALINIYOR, İLK TURLAR DEĞİL.
       *
       * Bir konuşmada sonuç genellikle sondadır: başta soru sorulur,
       * sonda karara varılır. Baştan kesmek, konuşmanın vardığı yeri
       * atıp gidiş yolunu bırakırdı.
       */
      const kesit = turns === null ? [] : turns.slice(-input.maxTurns);

      return {
        ok: true as const,
        data: {
          found: turns !== null,
          message:
            turns === null
              ? "Bu konuşma bulunamadı ya da size ait değil."
              : turns.length > kesit.length
                ? `${turns.length} turdan son ${kesit.length} tanesi gösteriliyor.`
                : "",
          conversationId: input.conversationId,
          totalTurns: turns?.length ?? 0,
          turns: kesit.map((t) => ({ question: t.question, answer: t.answer })),
        },
        sources: [kaynak(kesit.length)],
        risks:
          turns === null || kesit.length === 0
            ? []
            : [{ severity: "info" as const, message: TAZELIK_UYARISI }],
        confidence: 94,
      };
    },
  });

  return [search, read] as const;
}
