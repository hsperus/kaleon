-- 029 — Kullanıcı tanımlı izlemeler.
--
-- NÖBETÇİLER KODA GÖMÜLÜYDÜ VE BEŞ TANEYDİ. 134 tool'un beşi
-- izleniyordu; muhasebe, bordro, sabit kıymet, stok sayımı ve bakım
-- hiç izlenmiyordu. Yeni bir izleme eklemek kod değişikliği, dağıtım
-- ve test istiyordu — bu yüzden hiç eklenmedi.
--
-- Oysa neyi izlemek istediğini en iyi bilen kişi işletmenin sahibidir.
-- İzleme artık veridir: bir tool, bir alan, bir eşik ve bir cümle.
--
-- İZLEME SAHİBİNİN YETKİSİYLE KOŞAR. `owner_user_id` yalnızca bir
-- etiket değildir: izleme her çalıştığında o kullanıcının izinleriyle
-- çalışır. Aksi hâlde depo sorumlusunun kurduğu bir izleme, patron
-- ekranında onun göremeyeceği veriyi gösterirdi.

CREATE TABLE "watches" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    -- İzlenecek tool. YALNIZCA OKUMA TOOL'U (L0) kabul edilir;
    -- kontrol uygulama katmanındadır çünkü yetki seviyesi kayıt
    -- düzleminde değil tool tanımında yaşar.
    "tool" TEXT NOT NULL,
    "input" JSONB NOT NULL DEFAULT '{}',
    "path" TEXT NOT NULL,
    -- gt | gte | lt | lte | eq | neq | changed
    "operator" TEXT NOT NULL,
    "threshold" DOUBLE PRECISION,
    -- 0 sessiz, 1 not, 2 kritik.
    "level" INTEGER NOT NULL DEFAULT 1,
    "message" TEXT NOT NULL,
    -- İzlemenin koşacağı kimlik.
    "owner_user_id" UUID NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    -- "changed" karşılaştırması için son görülen değer.
    "last_value" DOUBLE PRECISION,
    "last_checked_at" TIMESTAMP(3),
    "last_fired_at" TIMESTAMP(3),
    "fire_count" INTEGER NOT NULL DEFAULT 0,
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "watches_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "watches_active_idx" ON "watches"("is_active");
CREATE INDEX "watches_owner_idx" ON "watches"("owner_user_id");

-- AYNI İZLEME İKİ KEZ KURULAMAZ. Kurulabilseydi aynı uyarı ekranda
-- iki kez çıkar ve kullanıcı hangisinin gerçek olduğunu bilemezdi.
CREATE UNIQUE INDEX "watches_owner_name_key"
    ON "watches"("owner_user_id", "name");

ALTER TABLE "watches" ADD CONSTRAINT "watches_level_range"
    CHECK ("level" BETWEEN 0 AND 2);
