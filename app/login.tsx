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

  // ── İkinci adım: şirket seçimi
  if (choices) {
    return (
      <div className="login-shell">
        <div className="login-card">
          <div className="login-brand">
            <i />
            <span>KAELON</span>
          </div>
          <p className="login-lead">Hangi şirkete giriyorsunuz?</p>
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
        <div className="login-brand">
          <i />
          <span>KAELON</span>
        </div>

        <label className="login-field">
          <span>E-posta</span>
          <input
            type="email"
            autoComplete="username"
            required
            autoFocus
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

        {error && <p className="login-error">{error}</p>}

        <button className="login-submit" type="submit" disabled={busy}>
          {busy ? "Kontrol ediliyor…" : "Giriş"}
        </button>

        <p className="login-note">
          Hesap oluşturma ekranı yoktur. Kullanıcılar yöneticiniz tarafından tanımlanır.
        </p>
      </form>
    </div>
  );
}
