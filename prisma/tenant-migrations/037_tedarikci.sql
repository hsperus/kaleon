-- 037 — Çerçeve sözleşme, tedarikçi karnesi ve fiyat kaydı.
--
-- ÖLÇÜLEN BOŞLUK: teklif toplama ve karşılaştırma vardı, ama seçimin
-- SONUCU ölçülmüyordu. Zamanında gelmeyen, eksik gönderen, sonradan
-- zam yapan tedarikçi bir sonraki turda aynı puanla yarışıyordu.
--
-- KARNE HESAPLANIR, ELLE GİRİLMEZ. Elle girilen bir puan, puanı
-- girenin o günkü ruh hâlini ölçer. Termin ve miktar performansı
-- zaten mal kabul kayıtlarında duruyor; oradan türetilir.

CREATE TABLE "purchase_contracts" (
    "id" UUID NOT NULL,
    "document_no" TEXT NOT NULL,
    "partner_id" UUID NOT NULL,
    "item_id" TEXT,
    "description" TEXT NOT NULL,
    "valid_from" DATE NOT NULL,
    "valid_to" DATE NOT NULL,
    -- Tavan: tutar ya da miktar. İkisi de null olabilir (açık uçlu
    -- anlaşma) ama o zaman sözleşme yalnızca fiyatı sabitler.
    "ceiling_amount" DECIMAL(18,2),
    "ceiling_quantity" DECIMAL(18,4),
    "unit_price" DECIMAL(18,4),
    "currency" TEXT NOT NULL DEFAULT 'TRY',
    -- active | expired | cancelled
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "purchase_contracts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "purchase_contracts_period" CHECK ("valid_to" >= "valid_from"),
    CONSTRAINT "purchase_contracts_status"
      CHECK ("status" IN ('active', 'expired', 'cancelled')),
    CONSTRAINT "purchase_contracts_ceiling_positive"
      CHECK (("ceiling_amount" IS NULL OR "ceiling_amount" > 0)
         AND ("ceiling_quantity" IS NULL OR "ceiling_quantity" > 0))
);

CREATE UNIQUE INDEX "purchase_contracts_no" ON "purchase_contracts"("document_no");
CREATE INDEX "purchase_contracts_partner" ON "purchase_contracts"("partner_id", "status");
CREATE INDEX "purchase_contracts_item" ON "purchase_contracts"("item_id", "status");

-- Sözleşmeden çekilen siparişler. Tavanın ne kadarının kullanıldığı
-- BURADAN toplanır; sözleşme satırında bir sayaç tutulsaydı iptal
-- edilen bir çekiliş sayacı düşürmez ve tavan sonsuza kadar dolu
-- görünürdü.
CREATE TABLE "contract_releases" (
    "id" UUID NOT NULL,
    "contract_id" UUID NOT NULL,
    "po_id" TEXT NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "released_at" DATE NOT NULL,
    "released_by" UUID NOT NULL,
    CONSTRAINT "contract_releases_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "contract_releases_positive" CHECK ("quantity" > 0 AND "amount" > 0),
    CONSTRAINT "contract_releases_contract_fk"
      FOREIGN KEY ("contract_id") REFERENCES "purchase_contracts"("id") ON DELETE CASCADE
);

-- BİR SİPARİŞ BİR SÖZLEŞMEDEN BİR KEZ ÇEKİLİR. Aynı siparişi iki kez
-- çekmek tavanı iki kat tüketirdi.
CREATE UNIQUE INDEX "contract_releases_po" ON "contract_releases"("contract_id", "po_id");

-- ── FİYAT KAYDI ──
--
-- Tedarikçi × malzeme son fiyat ve temin süresi. Teklif geçmişinden
-- ve gerçekleşen alımlardan beslenir; "aynı malı geçen sefer kaça
-- almıştık" sorusunun tek yerden cevabı.

CREATE TABLE "purchase_info_records" (
    "id" UUID NOT NULL,
    "partner_id" UUID NOT NULL,
    "item_id" TEXT NOT NULL,
    "last_price" DECIMAL(18,4) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'TRY',
    "last_ordered_at" DATE NOT NULL,
    "last_po_id" TEXT,
    -- Gerçekleşen temin süresi: sipariş ile mal kabul arasındaki gün.
    -- Malzeme kartındaki PLANLANAN süreden farklıdır ve fark önemlidir.
    "actual_lead_days" INTEGER,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "purchase_info_records_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "purchase_info_records_price" CHECK ("last_price" >= 0)
);

CREATE UNIQUE INDEX "purchase_info_records_unique"
  ON "purchase_info_records"("partner_id", "item_id", "currency");
CREATE INDEX "purchase_info_records_item" ON "purchase_info_records"("item_id");
