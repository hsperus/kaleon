/**
 * Entity Resolution testleri.
 *
 * Senaryo Ürün Mantığı §8'den birebir alınmıştır: Burçelik firması dört
 * farklı kaynakta dört farklı biçimde görünür. Bu testler geçmezse
 * Document Intelligence ve Finance sorgularının tamamı yanlış cevap verir.
 */

import { describe, expect, it } from "vitest";
import { invokeConfirmed } from "./helpers/confirm.js";
import { fold, jaroWinkler, normalizeName, tokenSimilarity } from "../src/modules/master-data/normalize.js";
import { isValidTckn, isValidVkn, parseTaxId } from "../src/modules/master-data/identifiers.js";
import {
  AUTO_MATCH,
  resolvePartner,
  type PartnerCandidate,
} from "../src/modules/master-data/resolver.js";

const BURCELIK: PartnerCandidate = {
  partnerId: "p-burcelik",
  legalName: "Burçelik Bursa Çelik Döküm Sanayi A.Ş.",
  taxIds: [{ kind: "vkn", value: "1234567890", valid: true }],
  externalRefs: [{ system: "uyumsoft", externalId: "SUP-00432" }],
  aliases: [
    { alias: "Burçelik", source: "confirmed" },
    { alias: "BURÇELİK A.Ş.", source: "confirmed" },
  ],
};

const BENZER: PartnerCandidate = {
  partnerId: "p-burcelik-metal",
  legalName: "Burçelik Metal Sanayi Ltd. Şti.",
  taxIds: [{ kind: "vkn", value: "8732154672", valid: true }],
  externalRefs: [],
  aliases: [],
};

const ALAKASIZ: PartnerCandidate = {
  partnerId: "p-zerey",
  legalName: "Zerey Tekstil Konfeksiyon Sanayi ve Ticaret A.Ş.",
  taxIds: [],
  externalRefs: [],
  aliases: [{ alias: "Zerey", source: "confirmed" }],
};

describe("Türkçe normalizasyon — büyük İ tuzağı", () => {
  it('JavaScript\'in toLowerCase() hatası düzeltilir', () => {
    // Naif yol birleşen nokta bırakır ve eşleşmeyi bozar:
    expect("BURÇELİK".toLowerCase()).not.toBe("burcelik");
    // fold() doğru sonucu verir:
    expect(fold("BURÇELİK")).toBe("burcelik");
    expect(fold("Burçelik")).toBe("burcelik");
    expect(fold("İSTANBUL")).toBe("istanbul");
    expect(fold("ÇĞİÖŞÜ")).toBe("cgiosu");
  });

  it("tüzel ekler ve sektör jenerikleri çekirdekten düşülür", () => {
    const n = normalizeName("Burçelik Bursa Çelik Döküm Sanayi A.Ş.");
    expect(n.core).toBe("burcelik bursa celik dokum");
    expect(n.full).toContain("sanayi");
  });

  it("her şey elenirse tam ad çekirdek olur", () => {
    const n = normalizeName("Sanayi ve Ticaret A.Ş.");
    expect(n.tokens.length).toBeGreaterThan(0);
  });

  it("token benzerliği kelime sırasından bağımsızdır", () => {
    expect(tokenSimilarity(["a", "b"], ["b", "a"])).toBe(1);
    expect(jaroWinkler("burcelik", "burcelik")).toBe(1);
    expect(jaroWinkler("burcelik", "burcelic")).toBeGreaterThan(0.9);
  });
});

describe("Vergi numarası checksum", () => {
  it("geçerli VKN kabul edilir", () => {
    expect(isValidVkn("1234567890")).toBe(true);
    expect(isValidVkn("8732154672")).toBe(true);
  });

  it("hatalı kontrol hanesi reddedilir", () => {
    expect(isValidVkn("1234567891")).toBe(false);
    expect(isValidVkn("8732154673")).toBe(false);
  });

  it("dolgu ve yanlış uzunluk reddedilir", () => {
    expect(isValidVkn("0000000000")).toBe(false);
    expect(isValidVkn("1111111111")).toBe(false);
    expect(isValidVkn("123")).toBe(false);
  });

  it("geçerli TCKN kabul edilir, hatalı reddedilir", () => {
    expect(isValidTckn("12345678950")).toBe(true);
    expect(isValidTckn("12345678951")).toBe(false);
    expect(isValidTckn("01234567890")).toBe(false);
  });

  it("parseTaxId tipi ve geçerliliği birlikte döndürür", () => {
    expect(parseTaxId("1234567890")).toEqual({ kind: "vkn", value: "1234567890", valid: true });
    expect(parseTaxId("1234567891")?.valid).toBe(false);
    expect(parseTaxId("12345678950")?.kind).toBe("tckn");
    expect(parseTaxId("abc")).toBeNull();
  });
});

describe("Çözümleme — dokümandaki Burçelik senaryosu", () => {
  const all = [BURCELIK, BENZER, ALAKASIZ];

  it("geçerli VKN kesin eşleşme kurar", () => {
    const r = resolvePartner({ taxId: "1234567890" }, all);
    expect(r.status).toBe("resolved");
    if (r.status === "resolved") {
      expect(r.match.partnerId).toBe("p-burcelik");
      expect(r.match.method).toBe("tax_id");
      expect(r.match.confidence).toBe(1);
    }
  });

  it("GEÇERSİZ VKN deterministik anahtar olarak kullanılmaz", () => {
    // Checksum'ı bozuk numara Burçelik'e ait gibi görünse de eşleşme kurmaz.
    const r = resolvePartner({ taxId: "1234567891" }, all);
    expect(r.status).toBe("not_found");
  });

  it("entegratör cari kimliği eşleşir", () => {
    const r = resolvePartner(
      { externalRef: { system: "uyumsoft", externalId: "SUP-00432" } },
      all,
    );
    expect(r.status).toBe("resolved");
    if (r.status === "resolved") expect(r.match.method).toBe("external_ref");
  });

  it('"BURÇELİK A.Ş." alias üzerinden çözülür', () => {
    const r = resolvePartner({ name: "BURÇELİK A.Ş." }, [BURCELIK, ALAKASIZ]);
    expect(r.status).toBe("resolved");
    if (r.status === "resolved") {
      expect(r.match.partnerId).toBe("p-burcelik");
      expect(r.match.confidence).toBeGreaterThanOrEqual(AUTO_MATCH);
    }
  });

  it("tüzel ek farkı eşleşmeyi bozmaz", () => {
    const r = resolvePartner(
      { name: "Burcelik Bursa Celik Dokum Sanayi Anonim Şirketi" },
      [BURCELIK, ALAKASIZ],
    );
    expect(r.status).toBe("resolved");
    if (r.status === "resolved") expect(r.match.partnerId).toBe("p-burcelik");
  });

  it("alakasız firma eşleşmez", () => {
    const r = resolvePartner({ name: "Tamamen Başka Bir Firma" }, all);
    expect(r.status).toBe("not_found");
  });
});

describe("Yanlış birleştirmeye karşı korumalar", () => {
  it("ONAYLANMIŞ alias belirsizliği çözer", () => {
    // "Burçelik" hem "Burçelik Bursa Çelik Döküm"ün alias'ıdır hem de
    // "Burçelik Metal"in içinde geçer. Alias'ı bir insan onayladığı için
    // sistem ona güvenir.
    const r = resolvePartner({ name: "Burçelik" }, [BURCELIK, BENZER]);
    expect(r.status).toBe("resolved");
    if (r.status === "resolved") {
      expect(r.match.partnerId).toBe("p-burcelik");
      expect(r.match.method).toBe("alias");
    }
  });

  it("DOĞRULANMAMIŞ alias tek başına otomatik eşleşme kuramaz", () => {
    const gozlemlenmis: PartnerCandidate = {
      ...BURCELIK,
      aliases: [{ alias: "Burçelik", source: "observed" }],
    };
    const r = resolvePartner({ name: "Burçelik" }, [gozlemlenmis, BENZER]);
    expect(r.status).toBe("review");
    if (r.status === "review") {
      expect(r.candidates.length).toBeGreaterThanOrEqual(2);
      expect(r.reason).toContain("otomatik");
    }
  });

  it("çok kelimeli yazım hatası yakalanır ama otomatik eşleşmez", () => {
    // OCR / elle giriş gerçekliği: dört kelimenin üçünde hata var.
    // Keskin Jaccard bunu kaçırırdı; bulanık token eşleştirmesi yakalar.
    // Yine de otomatik birleştirme yapılmaz — insana sorulur.
    const r = resolvePartner({ name: "Burcelk Bursa Celk Dokm" }, [BURCELIK]);
    expect(r.status).toBe("review");
    if (r.status === "review") {
      expect(r.candidates[0]?.method).toBe("fuzzy_name");
      expect(r.candidates[0]!.confidence).toBeLessThan(AUTO_MATCH);
      expect(r.candidates[0]!.confidence).toBeGreaterThan(0.75);
    }
  });

  it("birleştirilmiş kayıt hedefe yönlendirilir", () => {
    const eski: PartnerCandidate = {
      partnerId: "p-eski",
      legalName: "Burçelik Bursa Çelik Döküm Sanayi A.Ş.",
      taxIds: [{ kind: "vkn", value: "1234567890", valid: true }],
      externalRefs: [],
      aliases: [],
      mergedInto: "p-burcelik",
    };
    const r = resolvePartner({ taxId: "1234567890" }, [eski, ALAKASIZ]);
    expect(r.status).toBe("resolved");
    if (r.status === "resolved") expect(r.match.partnerId).toBe("p-burcelik");
  });

  it("birleştirme döngüsü sonsuza gitmez", () => {
    const a: PartnerCandidate = { partnerId: "a", legalName: "A", taxIds: [], externalRefs: [{ system: "s", externalId: "1" }], aliases: [], mergedInto: "b" };
    const b: PartnerCandidate = { partnerId: "b", legalName: "B", taxIds: [], externalRefs: [], aliases: [], mergedInto: "a" };
    const r = resolvePartner({ externalRef: { system: "s", externalId: "1" } }, [a, b]);
    expect(r.status).toBe("resolved");
  });

  it("her eşleşme insan tarafından okunabilir gerekçe taşır", () => {
    const r = resolvePartner({ taxId: "1234567890" }, [BURCELIK]);
    if (r.status === "resolved") {
      expect(r.match.evidence).toContain("checksum");
    }
  });
});

describe("resolve_partner tool — uçtan uca", () => {
  it("belirsizlik hata değil, kullanıcıya sorulacak bir durumdur", async () => {
    const { invokeTool } = await import("../src/kernel/invoke.js");
    const { buildRegistry } = await import("../src/app.js");
    const { InMemoryDataSource } = await import("../src/data/memory.js");
    const { InMemoryAuditSink } = await import("../src/kernel/audit.js");
    const { createPrincipal } = await import("../src/kernel/rbac.js");

    const res = await invokeConfirmed(
      "resolve_partner",
      { name: "Burçelik", taxId: null, externalSystem: null, externalId: null },
      {
        registry: buildRegistry(new InMemoryDataSource("t1")),
        audit: new InMemoryAuditSink(),
        principal: createPrincipal({ userId: "u1", tenantId: "t1", roles: ["satin_alma"] }),
        tenant: { tenantId: "t1", schema: "tenant_t1", locale: "tr-TR", baseCurrency: "TRY" },
        correlationId: "c1",
        channel: "chat",
      },
    );

    expect(res.outcome.ok).toBe(true);
    if (res.outcome.ok) {
      const data = res.outcome.data as { status: string };
      expect(data.status).toBe("resolved");
      expect(res.outcome.sources[0]?.system).toContain("Entity Resolution");
    }
  });

  it("depo sorumlusu bu tool'u göremez", async () => {
    const { buildRegistry } = await import("../src/app.js");
    const { InMemoryDataSource } = await import("../src/data/memory.js");
    const { createPrincipal } = await import("../src/kernel/rbac.js");
    const registry = buildRegistry(new InMemoryDataSource("t1"));
    const depo = createPrincipal({ userId: "u", tenantId: "t1", roles: ["depo_sorumlusu"] });
    expect(registry.catalogFor(depo).names).not.toContain("resolve_partner");
  });
});
