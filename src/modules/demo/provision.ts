/**
 * Demo tenant kurulumu.
 *
 * DENEYEN KİŞİ GERÇEK ÜRÜNÜ GÖRÜR. Sahte bir ekran değil: kendi
 * Postgres şeması, kendi kullanıcısı, kendi denetim kaydı. Aynı kodu,
 * aynı 141 tool'u, aynı yetki modelini çalıştırır. Tek farkı verinin
 * hazır gelmesi ve tenant'ın bir son kullanma tarihi taşıması.
 *
 * ─────────────────────────────────────────────────────────────────
 *
 * DÖRT SINIR, DÖRDÜ DE KÖTÜYE KULLANIM ÜZERİNE:
 *
 *  1. HER KURULUM BİR POSTGRES ŞEMASI + 30 GÖÇ demektir. Sınırsız
 *     bırakılsaydı tek bir betik veritabanını doldururdu. IP başına
 *     ve toplamda üst sınır var.
 *
 *  2. TENANT'IN SON KULLANMA TARİHİ VAR. Süresiz bir demo, aylar
 *     sonra kimsenin sahiplenmediği, gerçek kişisel veri taşıyan bir
 *     şemadır.
 *
 *  3. İLETİŞİM BİLGİSİ AYRI TABLODA. Kişisel veri işletmesel veriyle
 *     aynı yerde durmaz; "bilgimi silin" talebi tenant'a dokunmadan
 *     karşılanabilmeli.
 *
 *  4. IP HAM SAKLANMAZ. Oran sınırı için gerekli olan şey "aynı
 *     kaynak mı" bilgisidir, adresin kendisi değil. Tuzlanmış özet
 *     bunu verir ve geri döndürülemez.
 */

import { createHash, randomBytes } from "node:crypto";
import type { PrismaClient as SharedDb } from "../../db/generated/shared/index.js";
import { provisionTenantSchema, tenantSchemaName } from "../../db/provision.js";
import { tenantClient } from "../../db/client.js";
import { seedDemoTenant } from "./seed.js";
import { SECTORS } from "./sectors.js";

/** Demo tenant'ı bu süre sonunda düşürülür. */
export const DEMO_TTL_DAYS = 14;

/** Aynı kaynaktan bu pencerede en fazla bu kadar demo kurulur. */
export const RATE_WINDOW_HOURS = 24;
export const RATE_MAX_PER_CLIENT = 3;

/**
 * Toplam açık demo sayısı tavanı.
 *
 * Oran sınırı tek bir kaynağı durdurur; bu, dağıtık bir denemeye karşı
 * son settir. Tavana ulaşıldığında yeni demo açılmaz ve kişiye açıkça
 * söylenir — sessizce kuyruğa almak, çalışmayan bir ürün izlenimi verir.
 */
export const MAX_ACTIVE_DEMOS = 200;

export class DemoLimitError extends Error {
  readonly code = "demo_limit";
  constructor(message: string) {
    super(message);
    this.name = "DemoLimitError";
  }
}

/**
 * İstemci parmak izi — oran sınırı için.
 *
 * Tuz ortam değişkeninden gelir. Tanımsızsa süreç ömrü boyunca
 * rastgele bir tuz kullanılır: sınır yine çalışır ama sunucu yeniden
 * başlayınca sıfırlanır. Sabit bir varsayılan tuz yazmak, özeti
 * tahmin edilebilir ve dolayısıyla geri çevrilebilir yapardı.
 */
const SALT = process.env["KAELON_DEMO_SALT"] ?? randomBytes(16).toString("hex");

export function clientHash(ip: string): string {
  return createHash("sha256").update(`${SALT}:${ip}`).digest("hex").slice(0, 32);
}

/** Şirket adından güvenli, benzersiz bir slug. */
export function demoSlug(companyName: string): string {
  const base = companyName
    .toLocaleLowerCase("tr")
    .replace(/[çğıöşü]/g, (c) => ({ ç: "c", ğ: "g", ı: "i", ö: "o", ş: "s", ü: "u" })[c] ?? c)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  // Sonek çakışmayı engeller: iki "abc makina" aynı şemayı paylaşamaz.
  return `demo-${base || "sirket"}-${randomBytes(3).toString("hex")}`;
}

export interface DemoInput {
  readonly companyName: string;
  readonly legalName: string | null;
  readonly taxId: string | null;
  readonly taxOffice: string | null;
  readonly city: string | null;
  readonly sector: string;
  readonly employeeBand: string;
  readonly revenueBand: string;
  readonly exportCurrency: string;
  readonly currentSystem: string;
  readonly goals: string;
  readonly contactName: string;
  readonly contactTitle: string | null;
  readonly contactEmail: string;
  readonly contactPhone: string | null;
  readonly consentText: string;
  readonly ip: string;
}

export interface DemoResult {
  readonly tenantId: string;
  readonly slug: string;
  readonly schema: string;
  readonly expiresAt: Date;
}

/**
 * Sınırları denetler. Aşılmışsa SEBEBİYLE hata verir.
 *
 * Kurulumdan ÖNCE çağrılır: yarım kurulmuş bir şema bırakmaktansa hiç
 * başlamamak yeğdir.
 */
export async function assertWithinLimits(db: SharedDb, hash: string): Promise<void> {
  const since = new Date(Date.now() - RATE_WINDOW_HOURS * 3600_000);
  const recent = await db.demoRequest.count({
    where: { clientHash: hash, createdAt: { gte: since } },
  });
  if (recent >= RATE_MAX_PER_CLIENT) {
    throw new DemoLimitError(
      `Son ${RATE_WINDOW_HOURS} saatte bu bağlantıdan ${RATE_MAX_PER_CLIENT} demo açıldı. ` +
        `Yeni bir demo için yarını bekleyin ya da bize yazın — kurulumu biz yapalım.`,
    );
  }

  const active = await db.tenant.count({ where: { isDemo: true, status: "active" } });
  if (active >= MAX_ACTIVE_DEMOS) {
    throw new DemoLimitError(
      `Şu an açık demo sayısı üst sınırda. Birkaç saat içinde yer açılıyor; ` +
        `beklemek istemezseniz bize yazın.`,
    );
  }
}

/**
 * Demo tenant'ını kurar: şema, göçler, profil, veri.
 *
 * TALEP HER HÂLÜKÂRDA KAYDEDİLİR. Kurulum patlarsa `tenantId` null
 * kalır ama kayıt durur: başarısız denemeler de bilgidir ve o kişiye
 * geri dönülebilir.
 */
export async function provisionDemo(db: SharedDb, input: DemoInput): Promise<DemoResult> {
  const hash = clientHash(input.ip);
  await assertWithinLimits(db, hash);

  const sector = SECTORS.some((s) => s.id === input.sector) ? input.sector : SECTORS[0]!.id;
  const slug = demoSlug(input.companyName);
  const schema = tenantSchemaName(slug);
  const expiresAt = new Date(Date.now() + DEMO_TTL_DAYS * 86_400_000);

  const request = await db.demoRequest.create({
    data: {
      companyName: input.companyName,
      legalName: input.legalName,
      taxId: input.taxId,
      taxOffice: input.taxOffice,
      city: input.city,
      sector,
      employeeBand: input.employeeBand,
      revenueBand: input.revenueBand,
      exportCurrency: input.exportCurrency,
      currentSystem: input.currentSystem,
      goals: input.goals,
      contactName: input.contactName,
      contactTitle: input.contactTitle,
      contactEmail: input.contactEmail.toLocaleLowerCase("tr"),
      contactPhone: input.contactPhone,
      consentText: input.consentText,
      consentAt: new Date(),
      clientHash: hash,
    },
  });

  await provisionTenantSchema(db, slug);

  const tenant = await db.tenant.create({
    data: {
      slug,
      name: input.companyName,
      schemaName: schema,
      status: "active",
      sector,
      goals: input.goals,
      currentSystem: input.currentSystem,
      exportCurrency: input.exportCurrency,
      isDemo: true,
      expiresAt,
    },
  });

  await seedDemoTenant(tenantClient(schema) as never, {
    companyName: input.companyName,
    sector,
    legalName: input.legalName,
    taxId: input.taxId,
    taxOffice: input.taxOffice,
    city: input.city,
    revenueBand: input.revenueBand,
    exportCurrency: input.exportCurrency,
  });

  await db.demoRequest.update({
    where: { id: request.id },
    data: { tenantId: tenant.id },
  });

  return { tenantId: tenant.id, slug, schema, expiresAt };
}
