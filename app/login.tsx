"use client";

/**
 * Giriş ekranı.
 *
 * İKİ ALAN. E-posta ve parola.
 *
 * Şirket alanı YOKTUR: giriş ekranında tüm tenant'ları listeleyen bir açık
 * uç nokta, müşteri listesini herkese verirdi. Kullanıcı birden çok şirkette
 * çalışıyorsa, sunucu parolayı doğruladıktan SONRA yalnızca onun kendi
 * şirketlerini döner ve seçim ikinci adımda yapılır.
 *
 * 2FA kutusu da aynı mantıkla, yalnızca sunucu istediğinde belirir. Hesabında
 * 2FA olmayan kullanıcıya her girişte boş bir kutu göstermenin faydası yok.
 *
 * Hata mesajı sunucudan geldiği gibi gösterilir ve sunucu bilinçli olarak
 * ayrım yapmaz: "kullanıcı yok" ile "parola yanlış" aynı cümledir.
 */

import { useEffect, useRef, useState } from "react";

interface TenantChoice {
  readonly tenantId: string;
  readonly name: string;
}

export function LoginScreen({ onSuccess }: { readonly onSuccess: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [needsTotp, setNeedsTotp] = useState(false);
  const [choices, setChoices] = useState<readonly TenantChoice[] | null>(null);
  /** Parola sıfırlama ekranı. Kod yöneticiden telefonla gelir. */
  const [resetting, setResetting] = useState(false);
  const [resetCode, setResetCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [resetDone, setResetDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const totpRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (needsTotp) totpRef.current?.focus();
  }, [needsTotp]);

  async function attempt(tenantId?: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          password,
          ...(totpCode ? { totpCode } : {}),
          ...(tenantId ? { tenantId } : {}),
        }),
      });

      if (res.ok) {
        onSuccess();
        return;
      }

      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        tenants?: TenantChoice[];
      };

      if (body.error === "totp_required") {
        setNeedsTotp(true);
      } else if (body.error === "tenant_choice" && body.tenants) {
        setChoices(body.tenants);
      } else {
        setError(body.error ?? "Giriş yapılamadı.");
        setTotpCode("");
      }
    } catch {
      setError("Sunucuya ulaşılamadı.");
    } finally {
      setBusy(false);
    }
  }

  // ── Parola sıfırlama
  if (resetting) {
    return (
      <div className="login-shell">
        <form
          className="login-card"
          onSubmit={async (e) => {
            e.preventDefault();
            if (busy) return;
            setBusy(true);
            setError(null);
            try {
              const res = await fetch("/api/auth/reset", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ code: resetCode, newPassword }),
              });
              const body = (await res.json().catch(() => ({}))) as { error?: string };
              if (res.ok) {
                setResetDone(true);
                setResetCode("");
                setNewPassword("");
                setPassword("");
              } else {
                setError(body.error ?? "Parola değiştirilemedi.");
              }
            } catch {
              setError("Sunucuya ulaşılamadı.");
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="login-head">
            <span className="login-brand">KAELON</span>
            <span className="login-title">Parola sıfırla</span>
          </div>

          {resetDone ? (
            <>
              <p className="login-lead">Parolanız değiştirildi. Yeni parolanızla girebilirsiniz.</p>
              <button
                className="login-submit"
                type="button"
                onClick={() => {
                  setResetting(false);
                  setResetDone(false);
                  setError(null);
                }}
              >
                Giriş ekranına dön
              </button>
            </>
          ) : (
            <>
              <p className="login-lead">
                Yöneticinizden aldığınız kodu ve yeni parolanızı girin.
              </p>
              <div className="login-fields">
                <label className="login-field">
                  <span>Sıfırlama kodu</span>
                  <input
                    autoFocus
                    required
                    placeholder="ABCD-EFGH-JK"
                    value={resetCode}
                    onChange={(e) => setResetCode(e.target.value.toUpperCase())}
                  />
                </label>
                <label className="login-field">
                  <span>Yeni parola</span>
                  <input
                    type="password"
                    autoComplete="new-password"
                    required
                    minLength={10}
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                  />
                </label>
              </div>
              {error && <p className="login-error">{error}</p>}
              <button className="login-submit" type="submit" disabled={busy}>
                {busy ? "Değiştiriliyor…" : "Parolayı değiştir"}
              </button>
              <button
                className="login-link"
                type="button"
                onClick={() => {
                  setResetting(false);
                  setError(null);
                }}
              >
                Vazgeç
              </button>
            </>
          )}
        </form>
      </div>
    );
  }

  // ── İkinci adım: şirket seçimi
  if (choices) {
    return (
      <div className="login-shell">
        <div className="login-card">
          <div className="login-head">
            <span className="login-brand">KAELON</span>
            <span className="login-title">Hangi şirket?</span>
          </div>
          <div className="login-choices">
            {choices.map((t) => (
              <button
                key={t.tenantId}
                type="button"
                className="login-choice"
                disabled={busy}
                onClick={() => void attempt(t.tenantId)}
              >
                {t.name}
              </button>
            ))}
          </div>
          {error && <p className="login-error">{error}</p>}
        </div>
      </div>
    );
  }

  // ── Birinci adım
  return (
    <div className="login-shell">
      <form
        className="login-card"
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy) void attempt();
        }}
      >
        <div className="login-head">
          <span className="login-brand">KAELON</span>
          <span className="login-title">Giriş yapın</span>
        </div>

        <div className="login-fields">
          <label className="login-field">
            <span>E-posta</span>
            <input
              type="email"
              autoComplete="username"
              required
              autoFocus
              placeholder="ad@sirket.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>

          <label className="login-field">
            <span>Parola</span>
            <input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>

          {needsTotp && (
            <label className="login-field">
              <span>Doğrulama kodu</span>
              <input
                ref={totpRef}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                placeholder="000000"
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, ""))}
              />
            </label>
          )}
        </div>

        {error && <p className="login-error">{error}</p>}

        <button className="login-submit" type="submit" disabled={busy}>
          {busy ? "Kontrol ediliyor…" : "Giriş"}
        </button>

        {/* Parolasını unutan kullanıcı yöneticiyi arar; e-posta altyapısı
            olmadığı için kod telefonla iletilir. */}
        <button
          className="login-link"
          type="button"
          onClick={() => {
            setResetting(true);
            setError(null);
          }}
        >
          Parolamı unuttum
        </button>

        <p className="login-note">Hesabınızı yöneticiniz tanımlar.</p>
      </form>
    </div>
  );
}
