-- 023 — Makine çalışma saati sayacı.
--
-- Bakım planı sayaç bazlı çalışabiliyor ama okuyacağı sayaç yoktu:
-- makine anlık görüntüsünde yalnızca durum (çalışıyor/duruyor) vardı.
-- Bu, "sayaç bazlı bakım" tasarımını kâğıt üstünde bırakıyordu.
--
-- ALAN NULL OLABİLİR: her makinede sayaç yoktur. Sıfır yazılsaydı
-- "hiç çalışmadı" anlamına gelir ve bakım sonsuza kadar ertelenirdi.
ALTER TABLE "machine_status_snapshots" ADD COLUMN "running_hours" DECIMAL(12,2);

-- SAYAÇ GERİ GİTMEZ. Giderse ya sayaç sıfırlanmıştır ya da yanlış
-- okunmuştur; ikisi de bakım hesabını bozar ve fark edilmez.
CREATE OR REPLACE FUNCTION "machine_hours_no_rewind"()
RETURNS TRIGGER AS $$
DECLARE
  prev NUMERIC;
BEGIN
  IF NEW."running_hours" IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT "running_hours" INTO prev
    FROM "machine_status_snapshots"
   WHERE "machine_id" = NEW."machine_id" AND "running_hours" IS NOT NULL
   ORDER BY "as_of" DESC
   LIMIT 1;

  IF prev IS NOT NULL AND NEW."running_hours" < prev THEN
    RAISE EXCEPTION
      'Makine sayacı geri gidemez: % için son değer %, yeni değer %. Sayaç sıfırlandıysa bakım planı da güncellenmelidir.',
      NEW."machine_id", prev, NEW."running_hours";
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "machine_hours_no_rewind_trg"
  BEFORE INSERT ON "machine_status_snapshots"
  FOR EACH ROW EXECUTE FUNCTION "machine_hours_no_rewind"();
