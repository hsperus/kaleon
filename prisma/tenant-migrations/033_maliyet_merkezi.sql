-- 033 — Masraf merkezi ve bütçe (SAP CO karşılığı).
--
-- ÖLÇÜLEN BOŞLUK: `cost_center` diye bir tablo YOKTU. Sonucu şuydu:
-- gider bir departmana bağlanamıyordu ve "hangi departman ne harcadı,
-- bütçeyi aştık mı" sorusunun sistemde hiçbir cevabı yoktu.
--
-- BU EN GEÇ EKLENMESİ GEREKEN ŞEYDİ VE EN ERKEN EKLENMELİYDİ.
--
-- Yevmiye satırına bir boyut eklemek, sonradan eklenmesi en pahalı
-- şeydir: geçmiş kayıtlar boş kalır ve o boşluk BİR DAHA KAPANMAZ.
-- Bugün eklenirse bugünden sonrası tamdır; bir yıl sonra eklenirse
-- bir yıllık gider dağılımı sonsuza kadar bilinmez.
--
-- ─────────────────────────────────────────────────────────────────
--
-- MASRAF MERKEZİ YALNIZCA GİDER HESAPLARINDA ZORUNLU.
--
-- Bilanço hesabına masraf merkezi yazmak anlamsızdır: 102 Bankalar
-- hangi departmana ait olabilir? Kısıt bunu veritabanı seviyesinde
-- engelliyor — uygulama katmanındaki bir kural, bir betikle ya da
-- doğrudan psql ile aşılabilirdi.
--
-- Zorunluluk "gider hesabı varsa merkez OLMALI" değil, "merkez varsa
-- gider hesabı olmalı" biçiminde kuruldu. Sebebi: geçmiş satırlar
-- boş ve onları geriye dönük doldurmak uydurma olurdu.

CREATE TABLE "cost_centers" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    -- Sorumlusu — "bu merkez kimin bütçesi" sorusunun cevabı.
    "manager_employee_code" TEXT,
    -- Ağaç: üretim → kaynakhane, montaj. Üst merkez raporu alt
    -- merkezleri toplar.
    "parent_code" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "cost_centers_pkey" PRIMARY KEY ("id"),
    -- KENDİ KENDİNİN ÜSTÜ OLAMAZ. Bir merkezin kendi kendisini
    -- göstermesi, ağaç yürüyüşünü sonsuz döngüye sokar.
    CONSTRAINT "cost_centers_not_self_parent" CHECK ("parent_code" IS NULL OR "parent_code" <> "code")
);

CREATE UNIQUE INDEX "cost_centers_code" ON "cost_centers"("code");
CREATE INDEX "cost_centers_parent" ON "cost_centers"("parent_code");

-- Yevmiye satırına boyut. NULL kalabilir: geçmiş kayıtlar ve bilanço
-- hesapları için doğru olan budur.
ALTER TABLE "journal_lines" ADD COLUMN "cost_center_code" TEXT;

/*
 * BOYUT YALNIZCA GİDER HESABINDA.
 *
 * TDHP'de gider hesapları 6xx ve 7xx ile başlar. Masraf merkezi
 * yazılmış bir bilanço satırı, raporu ikiye böler: aynı tutar hem
 * "departman gideri" hem "varlık" olarak görünür.
 */
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_cost_center_only_expense"
  CHECK (
    "cost_center_code" IS NULL
    OR left("account_code", 1) IN ('6', '7')
  );

CREATE INDEX "journal_lines_cost_center_idx"
  ON "journal_lines"("cost_center_code", "account_code");

-- ── BÜTÇE ──
--
-- Masraf merkezi × hesap grubu × dönem. Hesap KODU değil GRUBU:
-- "770 Genel Yönetim Giderleri" bütçelenir, "770.01.003" değil.
-- Kod seviyesinde bütçe, hiç kimsenin dolduramayacağı bir tablo olur.

CREATE TABLE "budgets" (
    "id" UUID NOT NULL,
    "cost_center_code" TEXT NOT NULL,
    -- Üç haneli TDHP grubu (600, 770, 730...).
    "account_group" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    -- 1-12; NULL = yıllık bütçe, aya bölünmemiş.
    "month" INTEGER,
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'TRY',
    "note" TEXT,
    "set_by" UUID NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "budgets_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "budgets_month" CHECK ("month" IS NULL OR "month" BETWEEN 1 AND 12),
    CONSTRAINT "budgets_year" CHECK ("year" BETWEEN 2000 AND 2100),
    -- NEGATİF BÜTÇE YOKTUR. Sıfır vardır ("bu merkeze bu yıl hiç
    -- harcama yok") ve anlamlıdır; negatif ise bir işaret hatasıdır.
    CONSTRAINT "budgets_amount" CHECK ("amount" >= 0),
    CONSTRAINT "budgets_group" CHECK ("account_group" ~ '^[0-9]{3}$'),
    CONSTRAINT "budgets_center_fk"
      FOREIGN KEY ("cost_center_code") REFERENCES "cost_centers"("code") ON DELETE CASCADE
);

-- AYNI HÜCREYE İKİ BÜTÇE OLAMAZ. `month` NULL olabildiği için
-- iki ayrı kısmi indeks gerekiyor: NULL'lar birbirine eşit sayılmaz
-- ve tek indeks yıllık bütçenin mükerrerini engellemezdi.
CREATE UNIQUE INDEX "budgets_monthly"
  ON "budgets"("cost_center_code", "account_group", "year", "month")
  WHERE "month" IS NOT NULL;
CREATE UNIQUE INDEX "budgets_yearly"
  ON "budgets"("cost_center_code", "account_group", "year")
  WHERE "month" IS NULL;
