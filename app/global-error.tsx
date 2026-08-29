"use client";

/**
 * Kök hata sınırı.
 *
 * `app/error.tsx` yalnızca sayfa içindeki hataları yakalar; kök düzen
 * (layout) çökerse o da render edilemez. Bu dosya son savunma hattıdır ve
 * kendi <html>/<body> etiketlerini kurmak zorundadır.
 *
 * Burada CSS'e güvenilmez: stil dosyası yüklenememiş olabilir. Bu yüzden
 * satır içi stil kullanılır — hata ekranının kendisi çalışmıyorsa,
 * kullanıcı gerçekten bomboş bir sayfaya bakar.
 */

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="tr">
      <body
        style={{
          margin: 0,
          minHeight: "100dvh",
          display: "grid",
          placeItems: "center",
          background: "#070a0f",
          color: "#ecf1f7",
          fontFamily: "ui-sans-serif, system-ui, -apple-system, sans-serif",
          padding: 24,
        }}
      >
        <div style={{ maxWidth: 360, textAlign: "left" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 9, fontWeight: 700 }}>
            <span
              style={{
                width: 9,
                height: 9,
                borderRadius: "50%",
                background: "#45cbdd",
                display: "inline-block",
              }}
            />
            KAELON
          </div>
          <h1 style={{ fontSize: 20, margin: "18px 0 8px" }}>Uygulama açılamadı.</h1>
          <p style={{ fontSize: 14, lineHeight: 1.6, color: "#c2cbd7", margin: "0 0 18px" }}>
            Kaydedilmiş verileriniz yerinde duruyor. Sorun sürerse sistem yöneticinize
            bildirin.
            {error.digest && (
              <>
                <br />
                <span style={{ color: "#8a94a3", fontSize: 12 }}>Destek kodu: {error.digest}</span>
              </>
            )}
          </p>
          <button
            type="button"
            onClick={reset}
            style={{
              font: "inherit",
              fontSize: 14,
              fontWeight: 650,
              padding: "11px 18px",
              borderRadius: 12,
              border: 0,
              background: "#ecf1f7",
              color: "#070a0f",
              cursor: "pointer",
            }}
          >
            Tekrar dene
          </button>
        </div>
      </body>
    </html>
  );
}
