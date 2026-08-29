-- 004 — Yabancı anahtarlarda eksik indeksler.
--
-- Postgres yabancı anahtar için OTOMATİK indeks OLUŞTURMAZ (birincil
-- anahtardan farklı olarak). İndekssiz bir FK iki yerde ısırır:
--   · JOIN her seferinde tam tarama yapar;
--   · ana kayıt silinirken (ON DELETE CASCADE) çocuk tablo baştan sona
--     taranır — cari birleştirmede tablo büyüdükçe süre karesel artar.
--
-- CONCURRENTLY kullanılmıyor: migration transaction içinde koşuyor ve bu
-- tablolar henüz küçük. Büyük tablolara indeks eklenecekse ayrı bir bakım
-- penceresi gerekir.

CREATE INDEX "partner_tax_ids_partner_id_idx" ON "partner_tax_ids"("partner_id");
CREATE INDEX "partner_external_refs_partner_id_idx" ON "partner_external_refs"("partner_id");
CREATE INDEX "integration_errors_raw_payload_id_idx" ON "integration_errors"("raw_payload_id");
