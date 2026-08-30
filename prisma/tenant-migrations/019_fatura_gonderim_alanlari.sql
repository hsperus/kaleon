-- 019 — Kesilmiş faturada GÖNDERİM alanlarına izin.
--
-- 006'daki dokunulmazlık tetikleyicisi doğru bir kural koydu ama fazla
-- geniş tuttu: kesilmiş bir faturada HİÇBİR alan değişemiyordu. Oysa
-- ETTN, e-Fatura/e-Arşiv türü ve gönderim durumu faturanın MALİ İÇERİĞİ
-- DEĞİLDİR; belgenin entegratördeki yaşam döngüsünü anlatır.
--
-- Pratik sonucu şuydu: kesilmiş bir fatura için e-Fatura belgesi
-- üretilemiyordu — çünkü üretilen ETTN faturaya yazılamıyordu. Yani
-- mevzuatın zorunlu kıldığı adım, kendi koruma kuralımız yüzünden
-- imkânsızdı.
--
-- DEĞİŞMEZ KALAN NE: tutarlar, tarih, belge numarası, cari ve kalemler.
-- Faturanın tahrif edilmesi hâlâ imkânsızdır.

CREATE OR REPLACE FUNCTION "sales_invoices_immutable_when_issued"()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'draft' THEN
      RAISE EXCEPTION 'Kesilmiş fatura silinemez: %. İptal edilmelidir.', OLD."document_no";
    END IF;
    RETURN OLD;
  END IF;

  IF OLD."status" = 'issued' THEN
    -- MALİ İÇERİK DOKUNULMAZDIR.
    IF NEW."total_amount" <> OLD."total_amount"
       OR NEW."net_amount" <> OLD."net_amount"
       OR NEW."vat_amount" <> OLD."vat_amount"
       OR NEW."discount_amount" <> OLD."discount_amount"
       OR NEW."document_no" <> OLD."document_no"
       OR NEW."partner_id" <> OLD."partner_id"
       OR NEW."sales_order_id" IS DISTINCT FROM OLD."sales_order_id"
       OR NEW."currency" <> OLD."currency"
       OR NEW."exchange_rate" <> OLD."exchange_rate"
       OR NEW."issued_at" <> OLD."issued_at" THEN
      RAISE EXCEPTION 'Kesilmiş faturanın içeriği değiştirilemez: %', OLD."document_no";
    END IF;

    -- DURUM YALNIZCA İPTALE GİDEBİLİR. Geri "taslak"a dönmek, kesilmiş
    -- bir faturayı düzenlenebilir hâle getirmek demektir.
    IF NEW."status" <> 'issued' AND NEW."status" <> 'cancelled' THEN
      RAISE EXCEPTION 'Kesilmiş fatura yalnızca iptal edilebilir: %', OLD."document_no";
    END IF;

    -- ETTN BİR KEZ ATANIR. Değiştirilebilseydi, gönderilmiş bir belgenin
    -- kimliği sonradan başka bir belgeye devredilebilirdi.
    IF OLD."ettn" IS NOT NULL AND NEW."ettn" IS DISTINCT FROM OLD."ettn" THEN
      RAISE EXCEPTION 'ETTN değiştirilemez: %', OLD."document_no";
    END IF;
  END IF;

  IF OLD."status" = 'cancelled' THEN
    -- İptal edilmiş faturada yalnızca gönderim durumu güncellenebilir:
    -- entegratör iptal yanıtını sonradan bildirir.
    IF NEW."status" <> 'cancelled' OR NEW."total_amount" <> OLD."total_amount" THEN
      RAISE EXCEPTION 'İptal edilmiş fatura değiştirilemez: %', OLD."document_no";
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
