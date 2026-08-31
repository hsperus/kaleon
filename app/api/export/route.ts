/**
 * Tablo dışa aktarma — Excel.
 *
 * TABLOYU İSTEMCİ GÖNDERİR, SUNUCU BİÇİMLENDİRİR. Alternatif, her rapor
 * tool'una ayrı bir "dışa aktar" yolu eklemekti: 114 tool için 114
 * ayrı uç nokta, ve yeni bir tool eklendiğinde dışa aktarma unutulur.
 * Burada ekranda görünen HER tablo, hiçbir tool'a dokunmadan
 * aktarılabilir hâle geliyor.
 *
 * VERİ SIZINTISI YOK: uç nokta yalnızca kendisine verilen tabloyu geri
 * yazar; hiçbir veritabanına bakmaz. Yine de OTURUM ARANIR — aksi hâlde
 * herkese açık bir dosya dönüştürücü bırakmış oluruz.
 */

import { z } from "zod";
import { createContext, UnauthenticatedError } from "../../../src/server/context.js";
import { buildXlsx, type Column, type Sheet } from "../../../src/export/xlsx.js";
import { buildWord } from "../../../src/export/word.js";
import { log } from "../../../src/server/log.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Tek bir istekte aktarılabilecek üst sınırlar. */
const MAX_ROWS = 20_000;
const MAX_COLS = 60;
const MAX_SHEETS = 12;

const Body = z.object({
  title: z.string().min(1).max(120),
  sheets: z
    .array(
      z.object({
        name: z.string().min(1).max(60),
        head: z.array(z.string().max(200)).min(1).max(MAX_COLS),
        rows: z.array(z.array(z.string().max(500)).max(MAX_COLS)).max(MAX_ROWS),
        /** Hangi sütunlar sayısal — istemci zaten hesaplamış durumda. */
        numeric: z.array(z.boolean()).max(MAX_COLS),
      }),
    )
    .min(1)
    .max(MAX_SHEETS),
  /*
   * Biçim. Varsayılan Excel — mevcut istemciler alanı hiç göndermiyor
   * ve göndermediklerinde davranış değişmemeli.
   */
  format: z.enum(["xlsx", "doc"]).default("xlsx"),
});

/** Biçim başına içerik tipi ve uzantı. */
const BICIM = {
  xlsx: {
    uzanti: "xlsx",
    tip: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  },
  doc: {
    // `.docx` DEMİYORUZ. Word bu dosyayı açar ve biçimli gösterir ama
    // gerçek bir OOXML paketi değildir; uzantıyı olduğu gibi bırakmak
    // dürüstlüğün ta kendisi.
    uzanti: "doc",
    tip: "application/msword",
  },
} as const;

/**
 * Türkçe biçimli metni sayıya çevirir.
 *
 * "12.400.000,00" bir metin olarak yazılırsa Excel toplama yapamaz ve
 * kullanıcı dosyayı elle düzeltir — dışa aktarmanın bütün faydası
 * orada biter. Çevrilemeyen değer METİN OLARAK KALIR; uydurma bir sayı
 * üretmek, yanlış bir toplama yol açar.
 */
/**
 * Metin hücresinden markdown vurgusunu temizler.
 *
 * İstemci bunu zaten yapıyor; uç nokta kendi başına da doğru
 * davranmalı — hücrede "**TRY Toplam**" yazan bir Excel dosyası,
 * müşteriye gönderilecek bir tabloyu kullanılamaz hâle getirir.
 */
export function plainText(v: string): string {
  return v.replace(/\*\*/g, "").replace(/`/g, "").trim();
}

export function parseTurkishNumber(raw: string): number | null {
  // Yıldızlar istemcide temizleniyor; burada da yok sayılıyor çünkü
  // uç nokta kendi başına da doğru davranmalı.
  const t = raw.replace(/\*/g, "").trim().replace(/\s/g, "");
  if (!t || !/\d/.test(t)) return null;

  // Para birimi ve yüzde işaretleri ayrılır.
  const cleaned = t.replace(/(TL|TRY|USD|EUR|₺|\$|€|%|adet|kg|saat|gün)/gi, "").trim();
  if (!/^[-+]?[\d.,]+$/.test(cleaned)) return null;

  // Türkçe biçim: nokta binlik, virgül ondalık.
  const normalized = cleaned.replace(/\./g, "").replace(",", ".");
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

export async function POST(req: Request): Promise<Response> {
  let ctx;
  try {
    ctx = await createContext(req);
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return Response.json({ error: "unauthenticated" }, { status: 401 });
    }
    throw e;
  }

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json(
      { error: "invalid", detail: parsed.error.issues.map((i) => i.message).slice(0, 3) },
      { status: 400 },
    );
  }

  const sheets: Sheet[] = parsed.data.sheets.map((s) => {
    const columns: Column[] = s.head.map((h, i) => ({
      header: plainText(h),
      ...(s.numeric[i] ? { format: "money" as const } : {}),
    }));

    const rows = s.rows.map((r) =>
      s.head.map((_, i) => {
        const cell = plainText(r[i] ?? "");
        if (!s.numeric[i]) return cell;
        const n = parseTurkishNumber(cell);
        // Sayıya çevrilemeyen hücre METİN kalır: "—" ya da "bilinmiyor"
        // gibi değerler sıfıra çevrilirse toplam yalan söyler.
        return n === null ? cell : n;
      }),
    );

    return { name: s.name, columns, rows };
  });

  const bicim = parsed.data.format;
  const file =
    bicim === "doc" ? buildWord(parsed.data.title, sheets) : buildXlsx(sheets);
  const totalRows = parsed.data.sheets.reduce((n, s) => n + s.rows.length, 0);

  log.info("dosya dışa aktarıldı", {
    format: bicim,
    tenantId: ctx.tenant.tenantId,
    userId: ctx.principal.userId,
    route: "/api/export",
    sheets: sheets.length,
    rows: totalRows,
    bytes: file.length,
  });

  // Dosya adı ASCII'ye indirgenir ve ayrıca UTF-8 olarak verilir:
  // eski istemciler Türkçe karakterli adı bozuk indirir.
  const safe = parsed.data.title.replace(/[^\w\s.-]+/g, "-").replace(/\s+/g, "-").slice(0, 60);
  const { uzanti, tip } = BICIM[bicim];
  const encoded = encodeURIComponent(`${parsed.data.title}.${uzanti}`);

  return new Response(new Uint8Array(file), {
    status: 200,
    headers: {
      "Content-Type": tip,
      "Content-Disposition": `attachment; filename="${safe || "kaelon"}.${uzanti}"; filename*=UTF-8''${encoded}`,
      "Content-Length": String(file.length),
      "Cache-Control": "no-store",
    },
  });
}
