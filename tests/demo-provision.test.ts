/**
 * Demo kurulumu.
 *
 * Asıl iddia: DENEYEN KİŞİ GERÇEK ÜRÜNÜ GÖRÜR. Sahte bir ekran değil —
 * kendi Postgres şeması, kendi verisi, aynı 141 tool. Bu dosya zincirin
 * gerçekten kurulduğunu ve sektöre göre değiştiğini sınar.
 *
 * Sınırlar da burada: sınırsız kurulum veritabanını doldurur, süresiz
 * bir demo ise kimsenin sahiplenmediği kişisel veridir.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient as SharedPrisma } from "../src/db/generated/shared/index.js";
import { PrismaClient as TenantPrisma } from "../src/db/generated/tenant/index.js";
import { dropTenantSchema } from "../src/db/provision.js";
import { urlForSchema } from "../src/db/client.js";
import {
  DemoLimitError,
  RATE_MAX_PER_CLIENT,
  clientHash,
  demoSlug,
  provisionDemo,
  assertWithinLimits,
} from "../src/modules/demo/provision.js";
import { SECTORS, legalNameFor, sectorProfile } from "../src/modules/demo/sectors.js";

const SHARED_URL = process.env["SHARED_DATABASE_URL"];
const TENANT_URL = process.env["TENANT_DATABASE_URL"];
const enabled = Boolean(SHARED_URL && TENANT_URL);

function input(over: Partial<Parameters<typeof provisionDemo>[1]> = {}) {
  return {
    companyName: "Test Kalıp",
    sector: "plastik",
    employeeBand: "11–50",
    goals: "Kalıp maliyetlerini iş bazında göremiyoruz.",
    contactName: "Deneme Kişi",
    contactEmail: "deneme@example.com",
    contactPhone: null,
    consentText: "onay metni",
    ip: "203.0.113.9",
    ...over,
  };
}

describe("sektör profilleri", () => {
  it("HER SEKTÖRDE ÜÇ MAMUL VAR — sipariş onları kullanır", () => {
    for (const s of SECTORS) {
      const mamul = s.items.filter((i) => i.type === "mamul");
      expect(mamul, `${s.id} sektöründe mamul sayısı`).toHaveLength(3);
    }
  });

  it("HER SEKTÖRDE DÖRT KIYMET VE BEŞ ÇALIŞAN VAR", () => {
    for (const s of SECTORS) {
      expect(s.assets, s.id).toHaveLength(4);
      expect(s.staff, s.id).toHaveLength(5);
      // Üçüncüsü taşıt: kıst amortisman örneği ona bağlı (VUK 320).
      expect(s.assets[2]!.category, s.id).toBe("tasit");
    }
  });

  it("KALEM KODLARI SEKTÖR İÇİNDE BENZERSİZ", () => {
    for (const s of SECTORS) {
      const codes = s.items.map((i) => i.code);
      expect(new Set(codes).size, s.id).toBe(codes.length);
    }
  });

  it("bilinmeyen sektör makina profiline düşer", () => {
    expect(sectorProfile("yok-boyle-bir-sey").id).toBe("makina");
    expect(sectorProfile(null).id).toBe("makina");
  });

  describe("ticari unvan", () => {
    const plastik = sectorProfile("plastik");

    it("SEKTÖR KELİMESİ İKİ KEZ YAZILMAZ", () => {
      // "Yıldız Plastik Plastik Sanayi…" faturanın antetinde görünüyordu.
      expect(legalNameFor("Yıldız Plastik", plastik)).toBe(
        "Yıldız Plastik Sanayi ve Ticaret A.Ş.",
      );
    });

    it("adı olmayan sektör kelimesine ek yapılır", () => {
      expect(legalNameFor("Yıldız", plastik)).toBe("Yıldız Plastik Sanayi ve Ticaret A.Ş.");
    });

    it("ZATEN ŞİRKET TÜRÜ VARSA EK YAPILMAZ", () => {
      expect(legalNameFor("Yıldız Plastik A.Ş.", plastik)).toBe("Yıldız Plastik A.Ş.");
      expect(legalNameFor("Yıldız Kalıp Ltd. Şti.", plastik)).toBe("Yıldız Kalıp Ltd. Şti.");
    });
  });
});

describe("slug üretimi", () => {
  it("TÜRKÇE KARAKTERLER ŞEMA ADINDA KULLANILAMAZ", () => {
    const s = demoSlug("Yıldız Döküm Çelik");
    expect(s).toMatch(/^demo-[a-z0-9-]+$/);
    expect(s).toContain("yildiz-dokum-celik");
  });

  it("AYNI AD İKİ FARKLI SLUG ÜRETİR — şema çakışmasın", () => {
    expect(demoSlug("Aynı Şirket")).not.toBe(demoSlug("Aynı Şirket"));
  });

  it("boş ada düşülmez", () => {
    expect(demoSlug("!!!")).toMatch(/^demo-sirket-[a-f0-9]{6}$/);
  });
});

describe("istemci özeti", () => {
  it("IP HAM SAKLANMAZ — geri döndürülemez özet", () => {
    const h = clientHash("198.51.100.7");
    expect(h).not.toContain("198");
    expect(h).toHaveLength(32);
  });

  it("aynı IP aynı özeti verir", () => {
    expect(clientHash("198.51.100.7")).toBe(clientHash("198.51.100.7"));
  });
});

describe.skipIf(!enabled)("demo kurulumu kalıcılığı", () => {
  let shared: SharedPrisma;
  const created: string[] = [];

  beforeAll(() => {
    shared = new SharedPrisma();
  });

  afterAll(async () => {
    for (const slug of created) {
      await shared.tenant.deleteMany({ where: { slug } }).catch(() => {});
      await dropTenantSchema(shared, slug).catch(() => {});
    }
    await shared.demoRequest.deleteMany({ where: { contactEmail: "deneme@example.com" } });
    await shared.$disconnect();
  });

  it("GERÇEK ŞEMA KURULUR VE SEKTÖRE GÖRE DOLDURULUR", async () => {
    const r = await provisionDemo(shared, input({ ip: "203.0.113.10" }));
    created.push(r.slug);

    const db = new TenantPrisma({
      datasources: { db: { url: urlForSchema(TENANT_URL!, r.schema) } },
    });
    try {
      // Sektörün kendi ürünü — deneyen kişi kendi dünyasından bir
      // kelime görmezse geri kalanını okumaz.
      const item = await db.item.findUnique({ where: { code: "EN-31" } });
      expect(item?.name).toBe("Enjeksiyon Gövde EN-31");

      // Muhasebe zinciri gerçekten işlemiş olmalı.
      const invoice = await db.salesInvoice.findFirst();
      expect(invoice?.documentNo).toBeTruthy();

      // Bilanço çıkarılabilir olmalı: açılış kaydı yazılmış mı.
      const opening = await db.journalEntry.findFirst({
        where: { description: { contains: "Açılış" } },
      });
      expect(opening).not.toBeNull();

      // Bordro sekiz ay koşmuş olmalı — kümülatif matrah görünsün.
      expect(await db.payrollRun.count()).toBe(8);
    } finally {
      await db.$disconnect();
    }
  }, 120_000);

  it("PROFİL TENANT'A YAZILIR — ajan bağlamı buradan gelir", async () => {
    const slug = created[0]!;
    const t = await shared.tenant.findUnique({ where: { slug } });
    expect(t?.sector).toBe("plastik");
    expect(t?.goals).toContain("Kalıp maliyetlerini");
    expect(t?.isDemo).toBe(true);
    expect(t?.expiresAt).toBeInstanceOf(Date);
  });

  it("İLETİŞİM BİLGİSİ AYRI TABLODA VE RIZA KAYITLI", async () => {
    const req = await shared.demoRequest.findFirst({
      where: { contactEmail: "deneme@example.com" },
    });
    expect(req?.contactName).toBe("Deneme Kişi");
    expect(req?.consentText).toBe("onay metni");
    expect(req?.consentAt).toBeInstanceOf(Date);
    expect(req?.tenantId).toBeTruthy();
    // Ham IP saklanmaz.
    expect(req?.clientHash).not.toContain("203.0.113");
  });

  it("ORAN SINIRI AŞILINCA SEBEBİYLE DURDURUR", async () => {
    const ip = "203.0.113.77";
    const hash = clientHash(ip);
    // Sınıra kadar talep kaydı üret — kurulum yapmadan, hızlı olsun.
    for (let i = 0; i < RATE_MAX_PER_CLIENT; i += 1) {
      await shared.demoRequest.create({
        data: {
          companyName: `Sınır ${i}`,
          sector: "makina",
          employeeBand: "1–10",
          goals: "sınır testi",
          contactName: "Sınır",
          contactEmail: "deneme@example.com",
          consentText: "onay metni",
          consentAt: new Date(),
          clientHash: hash,
        },
      });
    }

    await expect(assertWithinLimits(shared, hash)).rejects.toThrow(DemoLimitError);
    // Mesaj ne yapılacağını söylemeli, yalnızca "hayır" dememeli.
    await expect(assertWithinLimits(shared, hash)).rejects.toThrow(/bize yazın|yarını bekleyin/);
  });
});
