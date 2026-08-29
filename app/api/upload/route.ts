/**
 * Dosya yükleme.
 *
 * DOSYA İÇERİĞİ MODELDEN GEÇMEZ. Yükleme sunucuda kalır ve modele yalnızca
 * bir KİMLİK verilir. Dört bin satırlık bir CSV'yi modele göndermek hem
 * pahalıdır hem gereksizdir: ayrıştırma ve doğrulama deterministik koddur.
 *
 * ÜÇ KONTROL, ÜÇÜ DE SUNUCUDA:
 *   1. BOYUT — istemcinin söylediği boyuta güvenilmez, gerçek okunan bayt
 *      sayılır. `Content-Length` sahtelenebilir.
 *   2. TÜR — yalnızca metin tabanlı tablo dosyaları. Uzantıya değil,
 *      içeriğin çözülebilirliğine bakılır.
 *   3. KİMLİK — oturum zorunlu; yükleme yükleyenin tenant'ına bağlanır.
 */

import { createContext, UnauthenticatedError, uploads } from "../../../src/server/context.js";
import { MAX_UPLOAD_BYTES } from "../../../src/modules/import/uploads.js";
import { parseCsv } from "../../../src/modules/import/csv.js";
import { askThrottle } from "../../../src/server/throttle.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_EXTENSIONS = [".csv", ".txt", ".tsv"];

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

  const gate = askThrottle.check(`upload:${ctx.principal.tenantId}:${ctx.principal.userId}`);
  if (!gate.allowed) {
    return Response.json({ error: "Çok fazla yükleme. Lütfen biraz bekleyin." }, { status: 429 });
  }

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) {
    return Response.json({ error: "Dosya bulunamadı." }, { status: 400 });
  }

  const lower = file.name.toLocaleLowerCase("tr");
  if (!ALLOWED_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
    return Response.json(
      {
        error:
          "Şu an yalnızca CSV dosyaları okunabiliyor. Excel'de " +
          '"Farklı Kaydet → CSV (Ayırıcı sınırlayıcılı)" ile kaydedin.',
      },
      { status: 415 },
    );
  }

  const bytes = await file.arrayBuffer();
  // İSTEMCİNİN SÖYLEDİĞİ BOYUTA GÜVENİLMEZ: gerçek okunan bayt sayılır.
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    return Response.json(
      { error: `Dosya çok büyük (${Math.round(bytes.byteLength / 1024 / 1024)} MB). Sınır 5 MB.` },
      { status: 413 },
    );
  }
  if (bytes.byteLength === 0) {
    return Response.json({ error: "Dosya boş." }, { status: 400 });
  }

  const content = new TextDecoder("utf-8").decode(bytes);

  // Okunamayan bir dosyayı depoya koymak, hatayı sohbetin ortasına erteler.
  // Burada anlamak, kullanıcıya hemen ve net söylemeyi sağlar.
  const table = parseCsv(content);
  if (table.headers.length === 0) {
    return Response.json({ error: "Dosyada başlık satırı bulunamadı." }, { status: 422 });
  }

  const uploadId = uploads.put({
    filename: file.name,
    content,
    tenantId: ctx.principal.tenantId,
    userId: ctx.principal.userId,
  });

  return Response.json({
    uploadId,
    filename: file.name,
    headers: table.headers,
    rowCount: table.rows.length,
    delimiter: table.delimiter,
  });
}
