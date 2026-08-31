-- 035 — Kalite yönetimi: kontrol planı, muayene ve uygunsuzluk.
--
-- ÖLÇÜLEN BOŞLUK: kalite kapısı vardı ("geçti/kaldı" kararı ve
-- gerekçeli aşım) ama ARKASINDA HİÇBİR KAYIT YOKTU. Ne ölçüldüğü
-- tutulmuyordu — yalnızca sonucu.
--
-- Bunun bedeli iki yerde çıkar: müşteri sertifika istediğinde elde
-- veri olmaz, ve bir parti geri çağrıldığında "hangi ölçüm sapmıştı"
-- sorusu cevapsız kalır. İzlenebilirlik altyapısı (parti/seri) zaten
-- hazırdı; üstüne ölçüm koymak ucuz.
--
-- ─────────────────────────────────────────────────────────────────
--
-- TOLERANS NULL OLABİLİR VE İKİSİ BİRDEN NULL OLAMAZ.
--
-- Bazı özellikler tek yönlüdür: sertlik "en az 45 HRC" olur, üst
-- sınırı yoktur. Bazıları ters: yüzey pürüzlülüğü "en fazla 3,2 µm".
-- İkisi birden boş olan bir özellik ise hiçbir şey ölçmez — o satır
-- kontrol planında yer kaplamaktan başka bir şey yapmaz.

CREATE TABLE "inspection_plans" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "item_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    -- incoming | in-process | final
    -- Nerede uygulanacağı: mal kabulde mi, üretim sırasında mı,
    -- sevkiyattan önce mi. Aynı ürünün üçü de olabilir.
    "stage" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "inspection_plans_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "inspection_plans_stage"
      CHECK ("stage" IN ('incoming', 'in-process', 'final'))
);

CREATE UNIQUE INDEX "inspection_plans_code" ON "inspection_plans"("code");
CREATE INDEX "inspection_plans_item" ON "inspection_plans"("item_id", "stage");

CREATE TABLE "inspection_characteristics" (
    "id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    -- numeric | attribute
    -- Sayısal: ölçülür, toleransla karşılaştırılır.
    -- Nitelik: bakılır, "var/yok" ya da "uygun/uygun değil".
    "kind" TEXT NOT NULL,
    "uom" TEXT,
    "lower_limit" DECIMAL(18,6),
    "upper_limit" DECIMAL(18,6),
    "method" TEXT,
    -- Bu özellik kaldığında parti KOMPLE reddedilir mi, yoksa
    -- şartlı kabul mümkün mü. Kritik özellikte aşım yapılamaz.
    "is_critical" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "inspection_characteristics_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "inspection_characteristics_kind" CHECK ("kind" IN ('numeric', 'attribute')),
    -- SAYISAL ÖZELLİKTE EN AZ BİR SINIR OLMALI. İkisi de boşsa o
    -- satır hiçbir şey ölçmez.
    CONSTRAINT "inspection_characteristics_limits"
      CHECK ("kind" <> 'numeric' OR "lower_limit" IS NOT NULL OR "upper_limit" IS NOT NULL),
    -- ALT SINIR ÜST SINIRDAN BÜYÜK OLAMAZ. Ters girilmiş bir tolerans
    -- her ölçümü "kaldı" yapar ve kimse sebebini anlamaz.
    CONSTRAINT "inspection_characteristics_range"
      CHECK ("lower_limit" IS NULL OR "upper_limit" IS NULL OR "lower_limit" <= "upper_limit"),
    CONSTRAINT "inspection_characteristics_plan_fk"
      FOREIGN KEY ("plan_id") REFERENCES "inspection_plans"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "inspection_characteristics_seq"
  ON "inspection_characteristics"("plan_id", "seq");

-- ── MUAYENE ──

CREATE TABLE "inspection_lots" (
    "id" UUID NOT NULL,
    "document_no" TEXT NOT NULL,
    "plan_id" UUID NOT NULL,
    "item_id" TEXT NOT NULL,
    -- Neyin muayenesi: parti, seri ya da belge. Üçü de null olabilir
    -- (numunesiz genel kontrol) ama en az biri dolu olmalı ki
    -- sonuç bir şeye bağlansın.
    "batch_no" TEXT,
    "serial_no" TEXT,
    "reference_doc" TEXT,
    "quantity" DECIMAL(18,4) NOT NULL,
    "inspected_at" TIMESTAMP(3) NOT NULL,
    "inspected_by" UUID NOT NULL,
    -- open | passed | failed | conditional
    "result" TEXT NOT NULL DEFAULT 'open',
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "inspection_lots_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "inspection_lots_result"
      CHECK ("result" IN ('open', 'passed', 'failed', 'conditional')),
    CONSTRAINT "inspection_lots_target"
      CHECK ("batch_no" IS NOT NULL OR "serial_no" IS NOT NULL OR "reference_doc" IS NOT NULL),
    CONSTRAINT "inspection_lots_plan_fk"
      FOREIGN KEY ("plan_id") REFERENCES "inspection_plans"("id")
);

CREATE UNIQUE INDEX "inspection_lots_no" ON "inspection_lots"("document_no");
CREATE INDEX "inspection_lots_item" ON "inspection_lots"("item_id", "inspected_at");
CREATE INDEX "inspection_lots_batch" ON "inspection_lots"("batch_no");

CREATE TABLE "inspection_results" (
    "id" UUID NOT NULL,
    "lot_id" UUID NOT NULL,
    "characteristic_id" UUID NOT NULL,
    -- Sayısal özellikte ölçülen değer; nitelikte null.
    "measured" DECIMAL(18,6),
    -- Nitelik özelliğinde uygun mu; sayısalda hesaplanır ve yazılır.
    "conforms" BOOLEAN NOT NULL,
    "note" TEXT,
    CONSTRAINT "inspection_results_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "inspection_results_lot_fk"
      FOREIGN KEY ("lot_id") REFERENCES "inspection_lots"("id") ON DELETE CASCADE,
    CONSTRAINT "inspection_results_char_fk"
      FOREIGN KEY ("characteristic_id") REFERENCES "inspection_characteristics"("id")
);

-- AYNI ÖZELLİK BİR MUAYENEDE BİR KEZ ÖLÇÜLÜR. İki ölçüm olsaydı
-- hangisinin geçerli olduğu belirsiz kalırdı; tekrar ölçüm yeni bir
-- muayene açar.
CREATE UNIQUE INDEX "inspection_results_unique"
  ON "inspection_results"("lot_id", "characteristic_id");

-- ── UYGUNSUZLUK (NCR) VE DÖF ──

CREATE TABLE "nonconformances" (
    "id" UUID NOT NULL,
    "document_no" TEXT NOT NULL,
    -- Nereden doğdu: muayene, müşteri şikâyeti, üretim.
    "source" TEXT NOT NULL,
    "lot_id" UUID,
    "item_id" TEXT,
    "batch_no" TEXT,
    "partner_id" UUID,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(18,4),
    "severity" TEXT NOT NULL,
    -- open | investigating | closed
    "status" TEXT NOT NULL DEFAULT 'open',
    "root_cause" TEXT,
    "corrective_action" TEXT,
    -- Etkilenen maliyet: hurda, yeniden işleme, iade.
    "cost_amount" DECIMAL(18,2),
    "opened_by" UUID NOT NULL,
    "opened_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_by" UUID,
    "closed_at" TIMESTAMP(3),
    CONSTRAINT "nonconformances_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "nonconformances_source"
      CHECK ("source" IN ('inspection', 'customer', 'production', 'supplier')),
    CONSTRAINT "nonconformances_severity"
      CHECK ("severity" IN ('minor', 'major', 'critical')),
    CONSTRAINT "nonconformances_status"
      CHECK ("status" IN ('open', 'investigating', 'closed')),
    /*
     * KÖK NEDEN VE DÜZELTİCİ FAALİYET OLMADAN KAPATILAMAZ.
     *
     * Uygunsuzluğu "kapandı" işaretleyip sebebini yazmamak, aynı
     * hatanın üç ay sonra tekrar etmesini garanti eder. Kaydın
     * kendisi bir şey düzeltmez; düzelten şey sebebin bulunmasıdır.
     */
    CONSTRAINT "nonconformances_close_needs_cause"
      CHECK (
        "status" <> 'closed'
        OR ("root_cause" IS NOT NULL AND "corrective_action" IS NOT NULL AND "closed_by" IS NOT NULL)
      )
);

CREATE UNIQUE INDEX "nonconformances_no" ON "nonconformances"("document_no");
CREATE INDEX "nonconformances_status_idx" ON "nonconformances"("status", "severity");
CREATE INDEX "nonconformances_item" ON "nonconformances"("item_id", "opened_at");
