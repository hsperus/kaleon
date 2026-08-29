import type { NextConfig } from "next";

const isProd = process.env.NODE_ENV === "production";

const config: NextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ["@prisma/client", ".prisma/client"],
  typescript: { ignoreBuildErrors: false },

  /**
   * Kaynak kodu ESM standardına uygun olarak `.js` uzantılı import kullanır
   * (TypeScript `verbatimModuleSyntax` bunu gerektirir). Webpack varsayılan
   * olarak `.js` isteğini `.ts` dosyasına çözmez; bu eşleme onu bağlar.
   * Kodu bozmak yerine bundler'ı doğru yapılandırmak doğru olan.
   */
  /**
   * Statik güvenlik başlıkları.
   *
   * CSP BURADA DEĞİL, `middleware.ts` içinde: her istekte yeni bir nonce
   * üretilmesi gerekiyor ve statik bir başlık dosyası bunu yapamaz. Sabit
   * bir nonce, nonce olmamakla aynı şeydir.
   */
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // Bu uygulamanın kameraya, mikrofona veya konuma ihtiyacı yok.
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          ...(isProd
            ? [
                {
                  key: "Strict-Transport-Security",
                  value: "max-age=63072000; includeSubDomains; preload",
                },
              ]
            : []),
        ],
      },
      {
        // API cevapları asla önbelleğe alınmaz: bir kullanıcının bakiyesi
        // araya giren bir önbellekten başkasına gösterilemez.
        source: "/api/:path*",
        headers: [{ key: "Cache-Control", value: "no-store, no-cache, must-revalidate" }],
      },
    ];
  },

  webpack: (cfg) => {
    cfg.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
      ".jsx": [".tsx", ".jsx"],
    };
    return cfg;
  },
};

export default config;
