-- 018 — e-Fatura kimlik alanları.
--
-- ÖNCESİNDE CARİ KARTINDA ADRES BİLE YOKTU. Ad, vergi numarası ve
-- müşteri/tedarikçi bayrağı vardı; e-Fatura için gereken adres, vergi
-- dairesi ve mükellefiyet durumu yoktu. Bu alanlar olmadan geçerli bir
-- UBL-TR belgesi üretilemez — üretilse bile entegratör reddeder.
--
-- ALANLAR NULL OLABİLİR çünkü mevcut cariler bunlarsız açılmıştır.
-- Zorunlu yapılsaydı göç imkânsız olurdu. Eksiklik, fatura kesilirken
-- AÇIKÇA söylenir; uydurma bir adresle geçersiz belge üretmek en kötü
-- seçenektir.

ALTER TABLE "partners"
  ADD COLUMN "tax_office" TEXT,
  ADD COLUMN "address_line" TEXT,
  ADD COLUMN "district" TEXT,
  ADD COLUMN "city" TEXT,
  ADD COLUMN "postal_code" TEXT,
  ADD COLUMN "email" TEXT,
  ADD COLUMN "phone" TEXT,
  ADD COLUMN "einvoice_user" BOOLEAN,
  ADD COLUMN "einvoice_alias" TEXT;

-- Şirketin kendi kimliği. Tek satır: `id` sabit 'singleton'.
CREATE TABLE "company_profile" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "legal_name" TEXT NOT NULL,
    "tax_id" TEXT NOT NULL,
    "tax_office" TEXT NOT NULL,
    "address_line" TEXT NOT NULL,
    "district" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "postal_code" TEXT,
    "country" TEXT NOT NULL DEFAULT 'TR',
    "email" TEXT,
    "phone" TEXT,
    "mersis_no" TEXT,
    "trade_registry_no" TEXT,
    "einvoice_alias" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "company_profile_pkey" PRIMARY KEY ("id")
);

-- İKİNCİ SATIR AÇILAMAZ. Açılabilseydi hangi kimliğin geçerli olduğu
-- belirsiz kalır ve fatura yanlış mükellef adına düzenlenebilirdi.
ALTER TABLE "company_profile"
  ADD CONSTRAINT "company_profile_singleton" CHECK ("id" = 'singleton');
