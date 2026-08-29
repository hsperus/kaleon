-- 002 — Konuşma sürekliliği.
--
-- Sohbet tabanlı bir ERP'de her sorunun sıfırdan başlaması kabul edilemez:
-- "peki ya geçen ay?" sorusu, bir önceki turu bilmeden cevaplanamaz.
--
-- SAKLANAN ŞEY YALNIZCA METİNDİR. Tool çağrıları ve sonuçları KAYDEDİLMEZ.
-- İki sebep: bayat veri taze gibi okunur (dünkü bakiye bugünkü cevaba
-- karışırsa sistem yanlış rakam söyler), ve geçmiş sınırsız büyür.
-- Model bilgiye yine ihtiyaç duyarsa tool'u tekrar çağırıp güncelini alır.

CREATE TABLE "conversations" (
  "id"         UUID NOT NULL,
  "user_id"    UUID NOT NULL,
  "title"      TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- Kullanıcı kendi konuşmalarını en yeniden eskiye listeler.
CREATE INDEX "conversations_user_id_updated_at_idx"
  ON "conversations"("user_id", "updated_at" DESC);

CREATE TABLE "conversation_messages" (
  "id"              UUID NOT NULL,
  "conversation_id" UUID NOT NULL,
  -- Tur numarası; sıra garantisi zamana değil bu sayaca dayanır.
  "seq"             INTEGER NOT NULL,
  "role"            TEXT NOT NULL,
  "content"         TEXT NOT NULL,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "conversation_messages_pkey" PRIMARY KEY ("id")
);

-- Aynı sıra numarası iki kez yazılamaz: eşzamanlı iki istek aynı konuşmaya
-- yazarsa biri hata alır ve sıra bozulmaz.
CREATE UNIQUE INDEX "conversation_messages_conversation_id_seq_key"
  ON "conversation_messages"("conversation_id", "seq");

ALTER TABLE "conversation_messages"
  ADD CONSTRAINT "conversation_messages_conversation_id_fkey"
  FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
