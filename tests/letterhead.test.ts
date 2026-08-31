/**
 * Antet.
 *
 * TEST EDİLEN ŞEY BİÇİM DEĞİL, DÜRÜSTLÜK. Antedin asıl işi, belgeyi
 * alan kişiye kimin gönderdiğini söylemek. Eksik bir alanı "—" ile
 * doldurmak o eksikliği gizler; hiç yazmamak gösterir.
 */

import { describe, expect, it } from "vitest";
import { letterheadFrom, legalFooter } from "../src/modules/documents/letterhead.js";

const TAM = {
  legalName: "ULS Havayolları Kargo A.Ş.",
  taxOffice: "Büyük Mükellefler",
  taxId: "9010203040",
  addressLine: "İstanbul Havalimanı Kargo Terminali",
  district: "Arnavutköy",
  city: "İstanbul",
  postalCode: "34283",
  phone: "+90 212 000 00 00",
  email: "muhasebe@uls.example",
  mersisNo: "0901020304000015",
  tradeRegistryNo: "123456-5",
};

describe("antet", () => {
  it("adresi tek satırda birleştirir", () => {
    const l = letterheadFrom(TAM, "ULS");
    expect(l.address).toBe("İstanbul Havalimanı Kargo Terminali · Arnavutköy/İstanbul · 34283");
  });

  it("eksik alanı UYDURMAZ, null bırakır", () => {
    const l = letterheadFrom({ ...TAM, mersisNo: null, tradeRegistryNo: "  " }, "ULS");
    expect(l.mersisNo).toBeNull();
    // Yalnızca boşluktan ibaret bir değer de yokluktur.
    expect(l.tradeRegistryNo).toBeNull();
  });

  it("profil hiç yoksa en azından adı taşır", () => {
    const l = letterheadFrom(null, "Yeni Şirket A.Ş.");
    expect(l.legalName).toBe("Yeni Şirket A.Ş.");
    expect(l.taxId).toBeNull();
    expect(l.address).toBeNull();
  });

  it("adres parçalarının hepsi boşsa adres null olur — boş ayraç kalmaz", () => {
    const l = letterheadFrom(
      { ...TAM, addressLine: "", district: null, city: "  ", postalCode: null },
      "ULS",
    );
    expect(l.address).toBeNull();
  });

  it("dipnot vergi dairesini ve numarayı birlikte yazar", () => {
    expect(legalFooter(letterheadFrom(TAM, "ULS"))).toBe(
      "ULS Havayolları Kargo A.Ş. · Büyük Mükellefler V.D. 9010203040 · " +
        "Tic. Sic. No: 123456-5 · Mersis: 0901020304000015",
    );
  });

  it("vergi dairesi bilinmiyorsa yalnızca numara yazılır", () => {
    const l = letterheadFrom({ ...TAM, taxOffice: null, mersisNo: null, tradeRegistryNo: null }, "X");
    expect(legalFooter(l)).toBe("ULS Havayolları Kargo A.Ş. · 9010203040");
  });

  it("hiçbir kimlik yoksa dipnot yalnızca addır — boş ayraçla bitmez", () => {
    expect(legalFooter(letterheadFrom(null, "Yeni A.Ş."))).toBe("Yeni A.Ş.");
  });
});
