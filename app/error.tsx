"use client";

/**
 * Hata sınırı.
 *
 * Bu dosya olmadan, arayüzde beklenmeyen bir hata BOMBOŞ BİR SAYFA demektir.
 * Kullanıcı ne olduğunu bilmez, ne yapacağını bilmez ve çoğu zaman sistemin
 * verisini kaybettiğini düşünür.
 *
 * İKİ KURAL:
 *
 *  1. TEKNİK AYRINTI KULLANICIYA GÖSTERİLMEZ. Yığın izi (stack trace) bir
 *     ERP ekranında hem anlamsızdır hem de iç yapıyı sızdırır. Kullanıcıya
 *     ne olduğu ve ne yapabileceği söylenir; ayrıntı sunucu loglarındadır.
 *
 *  2. VERİ KAYBI KORKUSU AÇIKÇA GİDERİLİR. Bir hata ekranının söylemesi
 *     gereken en önemli şey, kaydedilmiş verinin yerinde durduğudur.
 *     KAELON'da her yazma tool üzerinden ve denetim kaydıyla yapılır;
 *     ekranın çökmesi veriyi etkilemez.
 */

import { useEffect } from "react";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Ayrıntı konsola ve sunucu loglarına; ekrana değil.
    console.error("[KAELON] arayüz hatası:", error);
  }, [error]);

  return (
    <div className="login-shell">
      <div className="login-card" role="alert">
        <div className="login-head">
          <span className="login-brand">KAELON</span>
          <span className="login-title">Bir şeyler ters gitti</span>
        </div>

        <p className="login-lead">
          Bu ekran açılamadı. Kaydedilmiş verileriniz yerinde duruyor.
        </p>

        <button className="login-submit" type="button" onClick={reset}>
          Tekrar dene
        </button>

        <div className="login-choices">
          <button
            className="login-choice"
            type="button"
            onClick={() => {
              window.location.href = "/";
            }}
          >
            Ana ekrana dön
          </button>
        </div>

        {error.digest && (
          // Destek isteyen kullanıcının söyleyebileceği tek referans.
          // İçeriği anlamsızdır ama logdaki kaydı bulmayı sağlar.
          <p className="login-note">Destek kodu: {error.digest}</p>
        )}
      </div>
    </div>
  );
}
