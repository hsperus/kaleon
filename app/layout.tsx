import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

/**
 * HER İSTEK SUNUCUDA RENDER EDİLİR.
 *
 * Bunun sebebi performans tercihi değil, GÜVENLİK ZORUNLULUĞU: CSP nonce'u
 * her istekte yeniden üretilir ve ancak istek anında render edilen HTML'e
 * gömülebilir. Statik olarak önceden üretilmiş bir sayfanın script
 * etiketlerinde nonce olamaz.
 *
 * Bu ayar olmadan geliştirme çalışır, ÜRETİM TAMAMEN BOZULUR: bütün
 * script'ler CSP tarafından engellenir ve kullanıcı bomboş bir sayfa görür.
 * Üretim derlemesi çalıştırılıp tarayıcıda açılmasaydı fark edilmezdi.
 *
 * Zaten her sayfa oturuma bağlı; statik önceden üretimin bu uygulamada
 * kazandıracağı bir şey yok.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "KAELON",
  description: "AI-Native Operasyonel İşletim Sistemi",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="tr">
      <body>{children}</body>
    </html>
  );
}
