import type { NextConfig } from "next";

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
  webpack: (cfg) => {
    cfg.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
      ".jsx": [".tsx", ".jsx"],
    };
    return cfg;
  },
};

export default config;
