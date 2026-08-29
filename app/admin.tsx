"use client";

/**
 * Kullanıcı yönetimi ekranı.
 *
 * Yalnızca patrona görünür. Öncesinde bütün kullanıcı işlemleri CLI'daydı:
 * yönetici her yeni çalışan için üretim sunucusuna girmek zorundaydı ve
 * pratikte bu, herkesin aynı hesabı paylaşması demekti.
 *
 * İKİ TASARIM KARARI:
 *
 *  1. PAROLA YÖNETİCİ TARAFINDAN YAZILMAZ. Kullanıcı oluşturulunca tek
 *     kullanımlık bir kod çıkar; yönetici onu iletir, kullanıcı kendi
 *     parolasını belirler. Yöneticinin parola yazması, o parolanın bilinmesi
 *     demektir — ve çoğu yönetici herkese aynı parolayı verir.
 *
 *  2. SIR BİR KEZ GÖSTERİLİR. 2FA sırrı ve sıfırlama kodu yalnızca üretildiği
 *     anda görünür; listede tutulmaz. Listede tutulsaydı, listeyi gören
 *     herkes herkesin ikinci faktörünü görürdü.
 */

import { useCallback, useEffect, useState } from "react";

export interface AdminUser {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly roles: readonly string[];
  readonly isActive: boolean;
  readonly membershipActive: boolean;
  readonly twoFactor: boolean;
  readonly activeSessions: number;
}

export interface RoleOption {
  readonly id: string;
  readonly label: string;
}

export interface AdminApi {
  users(): Promise<readonly AdminUser[]>;
  roles(): Promise<readonly RoleOption[]>;
  createUser(input: {
    email: string;
    displayName: string;
    roles: string[];
  }): Promise<{ resetCode: string }>;
  setRoles(input: { userId: string; roles: string[] }): Promise<unknown>;
  setActive(input: { userId: string; active: boolean }): Promise<unknown>;
  issueReset(input: { userId: string }): Promise<{ code: string }>;
  revokeSessions(input: { userId: string }): Promise<{ revoked: number }>;
  enableTotp(input: { userId: string }): Promise<{ secret: string; uri: string }>;
  disableTotp(input: { userId: string }): Promise<unknown>;
}

/** Bir kez gösterilen sır — kopyalanabilir, kapatılınca kaybolur. */
function Secret({ title, value, note, onClose }: {
  title: string;
  value: string;
  note: string;
  onClose: () => void;
}) {
  return (
    <div className="admin-secret" role="alert">
      <div className="t">{title}</div>
      <code>{value}</code>
      <p>{note}</p>
      <button className="act" type="button" onClick={onClose}>
        Kapat
      </button>
    </div>
  );
}

export function AdminPanel({ api, onClose, selfId }: {
  api: AdminApi;
  onClose: () => void;
  selfId: string;
}) {
  const [users, setUsers] = useState<readonly AdminUser[] | null>(null);
  const [roles, setRoles] = useState<readonly RoleOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState<{ title: string; value: string; note: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ email: "", displayName: "", roles: [] as string[] });

  const refresh = useCallback(async () => {
    try {
      const [u, r] = await Promise.all([api.users(), api.roles()]);
      setUsers(u);
      setRoles(r);
    } catch (e) {
      setError((e as Error).message);
      setUsers([]);
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** Her eylem aynı sarmalayıcıdan geçer: hata gösterilir, liste tazelenir. */
  const run = useCallback(
    async (fn: () => Promise<void>) => {
      setBusy(true);
      setError(null);
      try {
        await fn();
        await refresh();
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  return (
    <>
      <div className="scrim" onClick={onClose} aria-hidden />
      <aside className="admin" aria-label="Kullanıcı yönetimi">
        <div className="admin-head">
          <span className="t">Kullanıcılar</span>
          <button className="panel-x" type="button" onClick={onClose} aria-label="Kapat">
            <svg viewBox="0 0 14 14" stroke="currentColor" strokeWidth="1.6" fill="none">
              <path d="M2 2l10 10M12 2L2 12" />
            </svg>
          </button>
        </div>

        <div className="admin-body">
          {error && <p className="login-error">{error}</p>}
          {secret && (
            <Secret {...secret} onClose={() => setSecret(null)} />
          )}

          {users === null ? (
            <p className="history-empty">Yükleniyor…</p>
          ) : (
            users.map((u) => (
              <div className={`admin-user${u.membershipActive ? "" : " off"}`} key={u.id}>
                <div className="admin-user-top">
                  <div className="who-block">
                    <div className="n">{u.displayName}</div>
                    <div className="e">{u.email}</div>
                  </div>
                  <div className="flags">
                    {u.twoFactor && <span className="flag on">2FA</span>}
                    {u.activeSessions > 0 && (
                      <span className="flag">{u.activeSessions} oturum</span>
                    )}
                    {!u.membershipActive && <span className="flag off">pasif</span>}
                  </div>
                </div>

                <div className="admin-roles">
                  {roles.map((r) => {
                    const on = u.roles.includes(r.id);
                    return (
                      <button
                        key={r.id}
                        type="button"
                        className={`role-chip${on ? " on" : ""}`}
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            const next = on
                              ? u.roles.filter((x) => x !== r.id)
                              : [...u.roles, r.id];
                            if (next.length === 0) {
                              throw new Error("En az bir rol kalmalı.");
                            }
                            await api.setRoles({ userId: u.id, roles: next });
                          })
                        }
                      >
                        {r.label}
                      </button>
                    );
                  })}
                </div>

                <div className="admin-actions">
                  <button
                    className="act"
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        const { code } = await api.issueReset({ userId: u.id });
                        setSecret({
                          title: `${u.displayName} · parola sıfırlama kodu`,
                          value: code,
                          note: "1 saat geçerli, tek kullanımlık. Kullanıcıya iletin; bu kod bir daha gösterilmez.",
                        });
                      })
                    }
                  >
                    Parola sıfırla
                  </button>

                  {u.twoFactor ? (
                    <button
                      className="act"
                      type="button"
                      disabled={busy}
                      onClick={() => void run(() => api.disableTotp({ userId: u.id }).then(() => undefined))}
                    >
                      2FA kapat
                    </button>
                  ) : (
                    <button
                      className="act"
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          const { secret: s, uri } = await api.enableTotp({ userId: u.id });
                          setSecret({
                            title: `${u.displayName} · 2FA sırrı`,
                            value: s,
                            note: `Google Authenticator'a girin. Bu sır bir daha gösterilmez. URI: ${uri}`,
                          });
                        })
                      }
                    >
                      2FA aç
                    </button>
                  )}

                  {u.activeSessions > 0 && (
                    <button
                      className="act"
                      type="button"
                      disabled={busy}
                      onClick={() => void run(() => api.revokeSessions({ userId: u.id }).then(() => undefined))}
                    >
                      Oturumları kapat
                    </button>
                  )}

                  {u.id !== selfId && (
                    <button
                      className="act"
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void run(() =>
                          api
                            .setActive({ userId: u.id, active: !u.membershipActive })
                            .then(() => undefined),
                        )
                      }
                    >
                      {u.membershipActive ? "Pasifleştir" : "Aktifleştir"}
                    </button>
                  )}
                </div>
              </div>
            ))
          )}

          {adding ? (
            <form
              className="admin-add"
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  const { resetCode } = await api.createUser({
                    email: form.email,
                    displayName: form.displayName,
                    roles: form.roles,
                  });
                  setSecret({
                    title: `${form.displayName} · ilk giriş kodu`,
                    value: resetCode,
                    note: "Kullanıcı bu kodla kendi parolasını belirler. 1 saat geçerli.",
                  });
                  setForm({ email: "", displayName: "", roles: [] });
                  setAdding(false);
                });
              }}
            >
              <label className="login-field">
                <span>Ad soyad</span>
                <input
                  required
                  autoFocus
                  value={form.displayName}
                  onChange={(e) => setForm({ ...form, displayName: e.target.value })}
                />
              </label>
              <label className="login-field">
                <span>E-posta</span>
                <input
                  type="email"
                  required
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                />
              </label>
              <div className="admin-roles">
                {roles.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    className={`role-chip${form.roles.includes(r.id) ? " on" : ""}`}
                    onClick={() =>
                      setForm({
                        ...form,
                        roles: form.roles.includes(r.id)
                          ? form.roles.filter((x) => x !== r.id)
                          : [...form.roles, r.id],
                      })
                    }
                  >
                    {r.label}
                  </button>
                ))}
              </div>
              <div className="admin-actions">
                <button className="login-submit" type="submit" disabled={busy || form.roles.length === 0}>
                  Oluştur
                </button>
                <button className="act" type="button" onClick={() => setAdding(false)}>
                  Vazgeç
                </button>
              </div>
            </form>
          ) : (
            <button className="act admin-new" type="button" onClick={() => setAdding(true)}>
              + Yeni kullanıcı
            </button>
          )}
        </div>
      </aside>
    </>
  );
}
