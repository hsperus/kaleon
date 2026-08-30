-- 027 — Dekont depo alanı metin olmalı.
--
-- 026'da `location_id` UUID olarak tanımlandı; oysa bu sistemde depo
-- KODLA anılır ("DEPO-1", "MERKEZ") ve `deliveries.location_id` de
-- metindir. İade kaydı, gelen malın gireceği depoyu yazamadan
-- düşüyordu.
--
-- DÜZELTME AYRI MİGRASYONDUR, 026 DEĞİŞTİRİLMEZ. Uygulanmış bir
-- migrasyonun içeriğini değiştirmek sağlama toplamını bozar ve
-- şemalar arasında sessiz bir ayrışma bırakır: bazı tenant'larda eski
-- hâli, bazılarında yenisi çalışmış olur ve hangisinin nerede olduğu
-- anlaşılamaz.

ALTER TABLE "sales_credit_notes"
    ALTER COLUMN "location_id" TYPE TEXT USING "location_id"::TEXT;
