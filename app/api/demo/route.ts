/**
 * Demo kurulum ucu.
 *
 * ÜÇ İŞ TEK İSTEKTE: tenant kurulur, kullanıcı açılır, oturum verilir.
 * Kullanıcıya parola belirletilmez — demoda parola koymak, denemeye
 * gelen kişiyi ürünü görmeden önce bir forma daha sokmak demektir.
 * Oturum normal oturumla aynı ömre ve aynı çereze sahiptir; ayrıcalık
 * yok, kısayol var.
 *
 * KURULUM SANİYELER SÜRER (30 göç + veri tohumlama). Bu yüzden arayüz
 * beklerken ne olduğunu anlatır; sessiz bir bekleme, bozuk bir ürün
 * izlenimi verir.
 *
 * HATA DURUMUNDA YARIM ŞEMA BIRAKILMAZ. Tohumlama patlarsa kurulan
 * şema düşürülür ve tenant pasifleştirilir; yarım kurulmuş bir tenant,
 * sonraki göç koşusunda herkesi bloke eder.
 */

import { z } from "zod";
import { sharedClient } from "../../../src/db/client.js";
import { dropTenantSchema } from "../../../src/db/provision.js";
import { DemoLimitError, provisionDemo } from "../../../src/modules/demo/provision.js";
import { SECTORS } from "../../../src/modules/demo/sectors.js";
import { PrismaAuthStore } from "../../../src/db/auth-store.js";
import { hashToken, issueToken, SESSION_TTL_MS } from "../../../src/auth/session.js";
import { hashPassword } from "../../../src/auth/password.js";
import { sessionCookie } from "../../../src/server/auth.js";
import { clientIp } from "../../../src/server/throttle.js";
import { log } from "../../../src/server/log.js";

export const runtime = "nodejs";
/** Kurulum saniyeler sürebilir; varsayılan kısa süre yetmez. */
export const maxDuration = 120;

/**
 * Onay metni SUNUCUDA TUTULUR.
 *
 * İstemciden gelen metne güvenilseydi, kaydedilen rıza metni kişinin
 * gerçekten gördüğü metin olmayabilirdi — ve KVKK açısından kayıt
 * değersizleşirdi.
 */
export const CONSENT_TEXT =
  "İletişim bilgilerimin KAELON demo talebimin değerlendirilmesi ve benimle " +
  "iletişime geçilmesi amacıyla işlenmesine onay veriyorum. Demo ortamı 14 gün " +
  "sonra silinir.";

const Body = z.object({
  companyName: z.string().trim().min(2).max(120),
  legalName: z.string().trim().max(160).nullable(),
  /*
   * VKN ON HANE, TCKN ON BİR. İkisi de kabul edilir çünkü şahıs
   * şirketleri TCKN ile fatura keser. Boş bırakılabilir: demo bu
   * alan olmadan da çalışır, yalnızca faturada örnek değer görünür.
   */
  taxId: z.string().trim().regex(/^\d{10,11}$/, "vkn").nullable().or(z.literal("")),
  taxOffice: z.string().trim().max(60).nullable(),
  city: z.string().trim().max(40).nullable(),
  sector: z.string().trim().min(1).max(40),
  employeeBand: z.string().trim().min(1).max(20),
  revenueBand: z.string().trim().min(1).max(20),
  exportCurrency: z.enum(["yok", "EUR", "USD"]),
  currentSystem: z.string().trim().min(1).max(20),
  goals: z.string().trim().min(10).max(600),
  contactName: z.string().trim().min(2).max(80),
  contactTitle: z.string().trim().max(60).nullable(),
  contactEmail: z.string().trim().email().max(160),
  contactPhone: z.string().trim().max(30).nullable(),
  consent: z.literal(true),
});

export async function POST(req: Request): Promise<Response> {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    const first = parsed.error?.issues[0];
    return Response.json(
      {
        error:
          first?.path.join(".") === "consent"
            ? "Devam etmek için onay kutusunu işaretlemeniz gerekiyor."
            : first?.message === "vkn"
              ? "Vergi numarası 10 hane (VKN) ya da 11 hane (TCKN) olmalı."
              : "Formda eksik ya da hatalı alan var.",
      },
      { status: 400 },
    );
  }
  const d = parsed.data;

  if (!SECTORS.some((s) => s.id === d.sector)) {
    return Response.json({ error: "Bilinmeyen sektör." }, { status: 400 });
  }

  const db = sharedClient();
  let slug: string | null = null;

  try {
    const demo = await provisionDemo(db, {
      companyName: d.companyName,
      legalName: d.legalName || null,
      taxId: d.taxId || null,
      taxOffice: d.taxOffice || null,
      city: d.city || null,
      sector: d.sector,
      employeeBand: d.employeeBand,
      revenueBand: d.revenueBand,
      exportCurrency: d.exportCurrency,
      currentSystem: d.currentSystem,
      goals: d.goals,
      contactName: d.contactName,
      contactTitle: d.contactTitle || null,
      contactEmail: d.contactEmail,
      contactPhone: d.contactPhone,
      consentText: CONSENT_TEXT,
      ip: clientIp(req),
    });
    slug = demo.slug;

    /*
     * KULLANICI PATRON ROLÜYLE AÇILIR.
     *
     * Demoda daha dar bir rol vermek, ziyaretçinin ürünün yarısını hiç
     * görmemesi demektir. Rolün ne yaptığını merak eden zaten uygulama
     * içinden diğer rollere bakabilir.
     *
     * PAROLA RASTGELE VE ATILIR. Hesaba parolayla girilmez; erişim
     * yalnızca bu isteğin verdiği çerezle olur. Boş parola bırakmak,
     * ileride bir yerde "parola kontrolü atlandı" hatası doğururdu.
     */
    const email = `${d.contactEmail.toLocaleLowerCase("tr")}`;
    const throwaway = await hashPassword(crypto.randomUUID() + crypto.randomUUID());
    const user = await db.user.upsert({
      where: { email },
      create: { email, displayName: d.contactName, passwordHash: throwaway },
      update: { displayName: d.contactName, isActive: true },
    });
    await db.membership.create({
      data: { userId: user.id, tenantId: demo.tenantId, roles: ["patron"] },
    });

    const token = issueToken();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    await new PrismaAuthStore(db).createSession({
      id: crypto.randomUUID(),
      userId: user.id,
      tenantId: demo.tenantId,
      tokenHash: hashToken(token),
      expiresAt,
    });

    log.info("demo kuruldu", { tenantId: demo.tenantId, sector: d.sector });

    return Response.json(
      { ok: true, company: d.companyName, expiresAt: demo.expiresAt.toISOString() },
      { status: 201, headers: { "Set-Cookie": sessionCookie(token, expiresAt) } },
    );
  } catch (e) {
    if (e instanceof DemoLimitError) {
      return Response.json({ error: e.message }, { status: 429 });
    }

    // Yarım kurulmuş şema bırakma: sonraki göç koşusunda herkesi bloke eder.
    if (slug) {
      await db.tenant.updateMany({ where: { slug }, data: { status: "suspended" } }).catch(() => {});
      await dropTenantSchema(db, slug).catch(() => {});
      await db.tenant.deleteMany({ where: { slug } }).catch(() => {});
    }

    log.error("demo kurulamadı", { error: e instanceof Error ? e.message : String(e) });
    return Response.json(
      {
        error:
          "Demo ortamı kurulamadı. Bu bizim tarafımızda bir sorun; " +
          "birkaç dakika sonra tekrar deneyin.",
      },
      { status: 500 },
    );
  }
}
