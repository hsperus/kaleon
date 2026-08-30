-- 013 — Ana veri değişiklik belgesi.
--
-- ÖNCESİNDE ANA VERİ SESSİZCE DEĞİŞİYORDU. Bir malzemenin değerleme
-- yöntemi, bir carinin vergi numarası ya da bir personelin ücreti
-- değiştiğinde hiçbir yerde iz kalmıyordu. "Bu fiyat neden değişmiş",
-- "vergi numarasını kim düzeltmiş" sorularının cevabı YOKTU — oysa
-- KAELON'un iddiası kurumsal hafıza olmaktır.
--
-- KAYIT UYGULAMADA DEĞİL BURADA ÜRETİLİR. Uygulamada üretilseydi bir
-- betik ya da ileride yazılacak bir kod yolu onu atlar ve değişiklik izsiz
-- kalırdı; üstelik iz var sanıldığı için kimse şüphelenmezdi.

CREATE TABLE "master_data_changes" (
    "id" UUID NOT NULL,
    "object_type" TEXT NOT NULL,
    "object_id" TEXT NOT NULL,
    "object_code" TEXT,
    "field" TEXT NOT NULL,
    "old_value" TEXT,
    "new_value" TEXT,
    "operation" TEXT NOT NULL,
    "changed_by" UUID,
    "changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "master_data_changes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "master_data_changes_object_idx"
  ON "master_data_changes"("object_type", "object_id", "changed_at");
CREATE INDEX "master_data_changes_changed_at_idx" ON "master_data_changes"("changed_at");
CREATE INDEX "master_data_changes_changed_by_idx" ON "master_data_changes"("changed_by");

-- ─────────────────────────────────────────────────────────────
-- Değişiklik yakalayıcı.
--
-- Satırın eski ve yeni hâlini JSON'a çevirip ALAN ALAN karşılaştırır.
-- Tek bir "satır değişti" kaydı yeterli olmazdı: denetimde sorulan soru
-- "ne değişti" değil, "HANGİ ALAN neyden neye değişti"dir.
--
-- GÜRÜLTÜ ALANLARI ATLANIR. `updated_at` her güncellemede değişir ve her
-- değişiklik belgesine bir satır daha ekler; gerçek değişiklikleri
-- görünmez kılan gürültü, iz tutmamakla aynı sonucu verir.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION "capture_master_data_change"()
RETURNS TRIGGER AS $$
DECLARE
  old_json JSONB;
  new_json JSONB;
  k TEXT;
  old_v TEXT;
  new_v TEXT;
  actor UUID;
  obj_code TEXT;
  obj_id TEXT;
  noisy TEXT[] := ARRAY['updated_at', 'created_at', 'normalized'];
BEGIN
  -- Aktör bilinmiyorsa NULL kalır; uydurulmaz.
  BEGIN
    actor := NULLIF(current_setting('kaelon.user_id', true), '')::UUID;
  EXCEPTION WHEN OTHERS THEN
    actor := NULL;
  END;

  IF TG_OP = 'DELETE' THEN
    old_json := to_jsonb(OLD);
    obj_id := old_json->>'id';
    obj_code := old_json->>'code';
    INSERT INTO "master_data_changes"
      ("id", "object_type", "object_id", "object_code", "field", "old_value", "new_value",
       "operation", "changed_by", "changed_at")
    VALUES (gen_random_uuid(), TG_TABLE_NAME, obj_id, obj_code, '*',
            old_json::TEXT, NULL, 'delete', actor, NOW());
    RETURN OLD;
  END IF;

  new_json := to_jsonb(NEW);
  obj_id := new_json->>'id';
  obj_code := new_json->>'code';

  IF TG_OP = 'INSERT' THEN
    -- Açılış tek satırla kaydedilir: her alan için ayrı satır yazmak,
    -- yeni bir malzeme kartında 20 satır üretir ve listeyi okunamaz kılar.
    INSERT INTO "master_data_changes"
      ("id", "object_type", "object_id", "object_code", "field", "old_value", "new_value",
       "operation", "changed_by", "changed_at")
    VALUES (gen_random_uuid(), TG_TABLE_NAME, obj_id, obj_code, '*',
            NULL, new_json::TEXT, 'insert', actor, NOW());
    RETURN NEW;
  END IF;

  old_json := to_jsonb(OLD);
  FOR k IN SELECT jsonb_object_keys(new_json) LOOP
    CONTINUE WHEN k = ANY(noisy);
    old_v := old_json->>k;
    new_v := new_json->>k;
    -- IS DISTINCT FROM: NULL'dan değere ve değerden NULL'a geçiş de
    -- değişikliktir; `<>` bunları sessizce atlardı.
    IF old_v IS DISTINCT FROM new_v THEN
      INSERT INTO "master_data_changes"
        ("id", "object_type", "object_id", "object_code", "field", "old_value", "new_value",
         "operation", "changed_by", "changed_at")
      VALUES (gen_random_uuid(), TG_TABLE_NAME, obj_id, obj_code, k,
              old_v, new_v, 'update', actor, NOW());
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "items_change_trg"
  AFTER INSERT OR UPDATE OR DELETE ON "items"
  FOR EACH ROW EXECUTE FUNCTION "capture_master_data_change"();

CREATE TRIGGER "partners_change_trg"
  AFTER INSERT OR UPDATE OR DELETE ON "partners"
  FOR EACH ROW EXECUTE FUNCTION "capture_master_data_change"();

CREATE TRIGGER "employees_change_trg"
  AFTER INSERT OR UPDATE OR DELETE ON "employees"
  FOR EACH ROW EXECUTE FUNCTION "capture_master_data_change"();

-- DEĞİŞİKLİK BELGESİ DEĞİŞTİRİLEMEZ VE SİLİNEMEZ.
--
-- Denetim kaydındaki kuralın aynısı: değiştirilebilen bir iz, iz değildir.
-- Değişikliği yapan kişinin izi de silebilmesi, bütün mekanizmayı
-- anlamsız kılar.
CREATE OR REPLACE FUNCTION "master_data_changes_immutable"()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Ana veri değişiklik belgesi değiştirilemez veya silinemez.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "master_data_changes_immutable_trg"
  BEFORE UPDATE OR DELETE ON "master_data_changes"
  FOR EACH ROW EXECUTE FUNCTION "master_data_changes_immutable"();
