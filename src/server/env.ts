/**
 * Ortam değişkeni doğrulaması.
 *
 * ERKEN VE GÜRÜLTÜLÜ PATLAMAK, GEÇ VE SESSİZ BOZULMAKTAN İYİDİR.
 *
 * Eksik bir `SHARED_DATABASE_URL` ile başlayan sunucu, ilk kullanıcı giriş
 * yapmaya çalışana kadar sağlıklı görünür; sonra anlaşılmaz bir Prisma
 * hatası verir. Eksik bir `ANTHROPIC_API_KEY` daha da sinsidir: uygulama
 * sessizce demo moduna düşer ve müşteri, uydurma verileri gerçek sanır.
 *
 * ÜRETİMDE KURALLAR SIKIDIR, GELİŞTİRMEDE DEĞİL:
 *   - Üretimde eksik/zayıf ayar sunucuyu BAŞLATMAZ.
 *   - Geliştirmede uyarı verilir ve devam edilir; her deneme için tam bir
 *     ortam kurmaya zorlamak, hiç denememeye yol açar.
 */

export interface EnvReport {
  readonly ok: boolean;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
  readonly production: boolean;
}

export interface EnvInput {
  readonly NODE_ENV?: string | undefined;
  readonly SHARED_DATABASE_URL?: string | undefined;
  readonly TENANT_DATABASE_URL?: string | undefined;
  readonly ANTHROPIC_API_KEY?: string | undefined;
}

/** Bağlantı dizesi gerçekten bir Postgres URL'i mi? */
function badPostgresUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "geçerli bir URL değil";
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    return `beklenen şema postgresql://, gelen ${url.protocol}//`;
  }
  if (!url.hostname) return "sunucu adı yok";
  if (!url.pathname || url.pathname === "/") return "veritabanı adı yok";
  return null;
}

export function checkEnv(env: EnvInput): EnvReport {
  const production = env.NODE_ENV === "production";
  const errors: string[] = [];
  const warnings: string[] = [];

  const required: [keyof EnvInput, string][] = [
    ["SHARED_DATABASE_URL", "kontrol düzlemi (tenant, kullanıcı, oturum)"],
    ["TENANT_DATABASE_URL", "tenant şemaları (işletmesel veri)"],
  ];

  for (const [key, purpose] of required) {
    const value = env[key];
    if (!value) {
      (production ? errors : warnings).push(`${key} tanımlı değil — ${purpose}.`);
      continue;
    }
    const problem = badPostgresUrl(value);
    if (problem) errors.push(`${key} kullanılamaz: ${problem}.`);
  }

  if (!env.ANTHROPIC_API_KEY) {
    // Üretimde demo moduna düşmek KABUL EDİLEMEZ: müşteri uydurma verileri
    // gerçek sanır. Bu sessiz düşüş, açık bir çökmeden çok daha pahalıdır.
    (production ? errors : warnings).push(
      "ANTHROPIC_API_KEY tanımlı değil — model bağlı değil, demo modu devrede.",
    );
  }

  if (production && env.SHARED_DATABASE_URL && env.TENANT_DATABASE_URL) {
    if (env.SHARED_DATABASE_URL === env.TENANT_DATABASE_URL) {
      warnings.push(
        "SHARED_DATABASE_URL ve TENANT_DATABASE_URL aynı; kontrol düzlemi ile " +
          "tenant verisi aynı bağlantıyı paylaşıyor.",
      );
    }
  }

  return { ok: errors.length === 0, errors, warnings, production };
}

/**
 * Açılışta çalışır. Üretimde hata varsa süreç BAŞLAMAZ.
 *
 * Yarı çalışan bir sunucu, çalışmayan bir sunucudan tehlikelidir: sağlık
 * kontrolünü geçer, trafik alır ve isteklerin bir kısmını sessizce bozar.
 */
export function assertEnv(env: EnvInput = process.env, log = console): EnvReport {
  const report = checkEnv(env);

  for (const w of report.warnings) log.warn(`[KAELON] uyarı: ${w}`);
  for (const e of report.errors) log.error(`[KAELON] hata: ${e}`);

  if (!report.ok) {
    throw new Error(
      `KAELON başlatılamadı — ${report.errors.length} ortam hatası:\n` +
        report.errors.map((e) => `  • ${e}`).join("\n"),
    );
  }
  return report;
}
