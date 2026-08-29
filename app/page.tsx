"use client";

/**
 * KAELON ana ekran — prototipin gerçek uca bağlı hâli.
 *
 * Buradaki her cevap `runConversation`'dan geliyor: model tool seçiyor,
 * invoker yetkiyi doğruluyor, audit yazılıyor, kaynak bilgisi tool
 * sonucundan taşınıyor. Ekranda uydurulmuş hiçbir şey yok — rol
 * değiştirildiğinde görünen tool sayısı ve alınan cevap gerçekten değişiyor.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import superjson from "superjson";
import type { AppRouter } from "../src/server/router.js";
import { PANEL_TOOLS, Panel, type PanelPayload } from "./panels.js";
import { LoginScreen } from "./login.js";
import { AdminPanel } from "./admin.js";
import type { RunEvent } from "../src/ai/runner.js";
import { formatDuration, toolLabel } from "../src/ai/tool-labels.js";

type Role =
  | "patron" | "cfo" | "ik_muduru" | "uretim_muduru"
  | "satin_alma" | "depo_sorumlusu" | "operator";

const ROLES: { id: Role; label: string }[] = [
  { id: "patron", label: "Patron" },
  { id: "cfo", label: "CFO" },
  { id: "uretim_muduru", label: "Üretim Müdürü" },
  { id: "satin_alma", label: "Satın Alma" },
  { id: "ik_muduru", label: "İK Müdürü" },
  { id: "depo_sorumlusu", label: "Depo Sorumlusu" },
  { id: "operator", label: "Operatör" },
];

interface Signal {
  readonly id: string;
  readonly level: 0 | 1 | 2;
  readonly title: string;
  readonly detail: string;
  readonly impact: number | null;
  readonly impactUnit?: string;
  readonly drilldown: { readonly tool: string; readonly input: unknown } | null;
}

interface Session {
  readonly userId: string;
  readonly roleLabel: string;
  readonly visibleTools: readonly string[];
  readonly totalTools: number;
  readonly modelConnected: boolean;
  readonly maxAuthority: number;
  readonly identitySource: "session" | "dev-header";
  readonly dataPlane: "demo" | "postgres";
  readonly displayName: string;
  readonly canManageUsers: boolean;
}

interface ToolCall { readonly tool: string; readonly ok: boolean; readonly code?: string; readonly durationMs: number }

interface TurnRisk {
  readonly severity: string;
  readonly message: string;
}

interface Turn {
  readonly question: string;
  readonly answer: string | null;
  readonly toolCalls: readonly ToolCall[];
  /**
   * Tool'ların ürettiği uyarılar.
   *
   * Bunlar modele de gidiyor ama YALNIZCA metne güvenmek yetmez: model
   * "2 siparişin riski bilinmiyor" uyarısını cümleye katmayabilir ve o
   * bilgi sessizce kaybolur. Yapısal uyarı, yapısal olarak gösterilir.
   */
  readonly risks: readonly TurnRisk[];
  /** Şu an çalışan tool — kullanıcı boş ekrana bakmasın. */
  readonly running: string | null;
}

/**
 * Yönetim çağrıları için tRPC köprüsü.
 *
 * Panel bileşeni tRPC'yi tanımaz: arayüzü saf bir sözleşmedir ve test
 * edilebilir. Bağlama burada yapılır.
 */
function adminApi(role: Role) {
  const c = client(role);
  return {
    users: () => c.adminUsers.query(),
    roles: () => c.adminRoles.query(),
    createUser: (i: { email: string; displayName: string; roles: string[] }) =>
      c.adminCreateUser.mutate(i),
    setRoles: (i: { userId: string; roles: string[] }) => c.adminSetRoles.mutate(i),
    setActive: (i: { userId: string; active: boolean }) => c.adminSetActive.mutate(i),
    issueReset: (i: { userId: string }) => c.adminIssueReset.mutate(i),
    revokeSessions: (i: { userId: string }) => c.adminRevokeSessions.mutate(i),
    enableTotp: (i: { userId: string }) => c.adminEnableTotp.mutate(i),
    disableTotp: (i: { userId: string }) => c.adminDisableTotp.mutate(i),
  };
}

function client(role: Role) {
  return createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: "/api/trpc",
        transformer: superjson,
        headers: () => ({ "x-kaelon-dev-role": role }),
      }),
    ],
  });
}

export default function Page() {
  /**
   * Kimlik durumu üç değerlidir ve üçü de ayrı ekran demektir:
   *   null      → henüz sorulmadı (boş ekran, kısa)
   *   "anon"    → oturum yok → giriş ekranı
   *   Session   → içeride
   * "Bilmiyorum"u "giriş yapılmamış" gibi göstermek, her sayfa yenilemede
   * bir anlığına giriş ekranı yanıp sönmesine yol açar.
   */
  const [authState, setAuthState] = useState<"loading" | "anon" | "in">("loading");
  const [role, setRole] = useState<Role>("patron");
  const [session, setSession] = useState<Session | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  /**
   * Aktif konuşma. Sunucu ilk olayda kimliği söyler; sonraki sorular bunu
   * gönderir ve model önceki turları görür. Sohbet tabanlı bir üründe
   * "peki ya geçen ay?" sorusunun cevaplanabilmesi buna bağlı.
   */
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [panels, setPanels] = useState<PanelPayload[]>([]);
  const [briefing, setBriefing] = useState<{ level: 0 | 1 | 2; signals: Signal[] } | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // `ask` closure'ı içinde güncel değeri okumak için ref; state tek başına
  // eski değeri yakalar ve ikinci soru yanlış konuşmaya gider.
  const conversationIdRef = useRef<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // `ask` closure'ında güncel değeri okumak için.
  const uploadRef = useRef<string | null>(null);
  /**
   * Eklenen dosya. İÇERİK BURADA DEĞİL — sunucuda. Elde yalnızca kimlik ve
   * kullanıcının doğrulayabileceği bir özet var (ad, satır ve sütun sayısı).
   * Ekranda özet göstermek önemli: kullanıcı yanlış dosyayı seçtiğini
   * soruyu yazmadan ÖNCE anlamalı.
   */
  const [upload, setUpload] = useState<
    { id: string; filename: string; rowCount: number; headers: string[] } | null
  >(null);
  const [uploading, setUploading] = useState(false);
  /** Geçmiş konuşmalar. Açılınca yüklenir; her istekte çekmek gereksiz. */
  const [history, setHistory] = useState<
    { id: string; title: string; updatedAt: string }[] | null
  >(null);
  const [showAdmin, setShowAdmin] = useState(false);

  useEffect(() => {
    const c = client(role);
    c.session
      .query()
      .then((s) => {
        setSession(s);
        setAuthState("in");
      })
      .catch(() => {
        setSession(null);
        setAuthState("anon");
      });
    c.briefing
      .query()
      .then((b) => setBriefing({ level: b.level, signals: [...b.signals] as Signal[] }))
      .catch(() => setBriefing(null));
  }, [role, reloadKey]);

  useEffect(() => {
    stageRef.current?.scrollTo({ top: stageRef.current.scrollHeight, behavior: "smooth" });
  }, [turns, busy]);

  const ask = useCallback(
    async (question: string) => {
      if (!question.trim() || busy) return;
      setBusy(true);
      setValue("");
      setTurns((t) => [...t, { question, answer: null, toolCalls: [], risks: [], running: null }]);

      const patch = (fn: (t: Turn) => Turn) =>
        setTurns((list) => {
          const next = [...list];
          next[next.length - 1] = fn(next[next.length - 1]!);
          return next;
        });

      try {
        const res = await fetch("/api/ask", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-kaelon-dev-role": role },
          body: JSON.stringify({
            question,
            ...(conversationIdRef.current ? { conversationId: conversationIdRef.current } : {}),
            ...(uploadRef.current ? { uploadId: uploadRef.current } : {}),
          }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `Sunucu ${res.status} döndü.`);
        }
        if (!res.body) throw new Error("Akış açılamadı");

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        for (;;) {
          const { done, value: chunk } = await reader.read();
          if (done) break;
          buffer += decoder.decode(chunk, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.trim()) continue;
            const ev = JSON.parse(line) as
              | RunEvent
              | { type: "error"; message: string }
              | { type: "conversation"; id: string };

            if (ev.type === "conversation") {
              conversationIdRef.current = ev.id;
              setConversationId(ev.id);
            } else if (ev.type === "tool_start") {
              patch((t) => ({ ...t, running: ev.tool }));
            } else if (ev.type === "tool_end") {
              patch((t) => ({
                ...t,
                running: null,
                toolCalls: [
                  ...t.toolCalls,
                  { tool: ev.tool, ok: ev.ok, durationMs: ev.durationMs, ...(ev.code ? { code: ev.code } : {}) },
                ],
                // Aynı uyarı iki tool'dan da gelebilir; tekrarı gösterme.
                risks: dedupeRisks([...t.risks, ...(ev.risks ?? [])]),
              }));
              if (ev.ok && PANEL_TOOLS.has(ev.tool) && ev.data !== undefined) {
                setPanels((p) => [
                  { tool: ev.tool, data: ev.data, sources: ev.sources ?? [] },
                  ...p.filter((x) => x.tool !== ev.tool),
                ]);
              }
            } else if (ev.type === "text") {
              patch((t) => ({ ...t, answer: ev.text, running: null }));
            } else if (ev.type === "error") {
              patch((t) => ({ ...t, answer: `İstek tamamlanamadı: ${ev.message}`, running: null }));
            }
          }
        }
      } catch (e) {
        patch((t) => ({ ...t, answer: `İstek tamamlanamadı: ${(e as Error).message}`, running: null }));
      } finally {
        setBusy(false);
        inputRef.current?.focus();
      }
    },
    [busy, role],
  );

  /** Yeni konuşma — geçmiş kopar, ekran temizlenir. */
  const newConversation = useCallback(() => {
    conversationIdRef.current = null;
    setConversationId(null);
    setTurns([]);
    setPanels([]);
    setUpload(null);
    uploadRef.current = null;
    inputRef.current?.focus();
  }, []);

  /** Geçmişi açar ve listeyi tazeler. */
  const openHistory = useCallback(async () => {
    setHistory([]);
    try {
      const rows = await client(role).conversations.query();
      setHistory([...rows]);
    } catch {
      setHistory([]);
    }
  }, [role]);

  /** Bir konuşmayı geri yükler. */
  const loadConversation = useCallback(
    async (id: string) => {
      try {
        const rows = await client(role).conversation.query({ id });
        conversationIdRef.current = id;
        setConversationId(id);
        setTurns(
          rows.map((t) => ({
            question: t.question,
            answer: t.answer,
            toolCalls: [],
            risks: [],
            running: null,
          })),
        );
        setPanels([]);
        setHistory(null);
      } catch {
        // Konuşma silinmiş veya başkasına ait: listeyi tazele.
        void openHistory();
      }
    },
    [role, openHistory],
  );

  const attachFile = useCallback(async (file: File) => {
    setUploading(true);
    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch("/api/upload", { method: "POST", body });
      const data = (await res.json()) as {
        uploadId?: string;
        filename?: string;
        rowCount?: number;
        headers?: string[];
        error?: string;
      };
      if (!res.ok || !data.uploadId) {
        // Hata sohbet akışında değil, dosya kutusunda gösterilir: kullanıcı
        // düzeltmeyi burada yapacak.
        setUpload(null);
        uploadRef.current = null;
        window.alert(data.error ?? "Dosya yüklenemedi.");
        return;
      }
      uploadRef.current = data.uploadId;
      setUpload({
        id: data.uploadId,
        filename: data.filename ?? file.name,
        rowCount: data.rowCount ?? 0,
        headers: data.headers ?? [],
      });
      inputRef.current?.focus();
    } catch {
      window.alert("Dosya yüklenemedi.");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }, []);

  const chatting = turns.length > 0;

  if (authState === "loading") return <div className="shell boot" />;
  if (authState === "anon") {
    return (
      <LoginScreen
        onSuccess={() => {
          conversationIdRef.current = null;
          setConversationId(null);
          setTurns([]);
          setPanels([]);
          setAuthState("loading");
          setReloadKey((k) => k + 1);
        }}
      />
    );
  }

  return (
    <div className="shell" style={{ position: "relative" }}>
      <header className="topbar">
        <div className="brand">KAELON</div>
        <div className="who">
          {session?.displayName ?? "…"} · <b>{session?.roleLabel ?? "…"}</b>
        </div>
        <div className="spacer" />
        {/* TEK SESSİZ DURUM İŞARETİ.
            Üst çubukta iki amber hap duruyordu ve ekranı bir demo sayfasına
            çeviriyordu. Bilgi kalmalı — ama bağırmadan. Gerçek kurulumda
            (model bağlı + gerçek tenant) hiç görünmez. */}
        {session && (session.dataPlane === "demo" || !session.modelConnected) && (
          <span
            className="status"
            title={[
              session.dataPlane === "demo" ? "İşletmesel veri demo kümesinden geliyor" : "",
              !session.modelConnected ? "Model bağlı değil (ANTHROPIC_API_KEY tanımsız)" : "",
            ]
              .filter(Boolean)
              .join(" · ")}
          >
            <i />
            {session.dataPlane === "demo" ? "Demo" : "Modelsiz"}
          </span>
        )}

        {/* Konuşma sürüyorsa yeni konuşma açılabilsin; sürmüyorsa buton
            gereksiz gürültüdür. */}
        <button
          className="icon-btn"
          type="button"
          onClick={() => void (history === null ? openHistory() : setHistory(null))}
          title="Geçmiş konuşmalar"
          aria-label="Geçmiş konuşmalar"
        >
          <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
            <path
              d="M2.5 4h11M2.5 8h11M2.5 12h7"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </button>
        {session?.canManageUsers && (
          <button
            className="icon-btn"
            type="button"
            onClick={() => setShowAdmin(true)}
            title="Kullanıcılar"
            aria-label="Kullanıcı yönetimi"
          >
            <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
              <circle cx="8" cy="5.5" r="2.6" stroke="currentColor" strokeWidth="1.4" fill="none" />
              <path
                d="M2.8 13.6c.7-2.6 2.7-4 5.2-4s4.5 1.4 5.2 4"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                fill="none"
              />
            </svg>
          </button>
        )}
        {conversationId && turns.length > 0 && (
          <button
            className="icon-btn"
            type="button"
            onClick={newConversation}
            title="Yeni konuşma"
            aria-label="Yeni konuşma"
          >
            <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
              <path
                d="M8 3.2v9.6M3.2 8h9.6"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
          </button>
        )}
        {/* Rol seçici YALNIZCA geliştirme kimliğiyle görünür. Gerçek oturumda
            rol kullanıcının üyeliğinden gelir ve arayüzden değiştirilemez. */}
        {session?.identitySource === "dev-header" ? (
          <select
            className="role"
            value={role}
            onChange={(e) => {
              setRole(e.target.value as Role);
              newConversation();
            }}
            aria-label="Rol (geliştirme)"
            title="Geliştirme kimliği — üretimde bu seçici yoktur"
          >
            {ROLES.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
        ) : null}
        {session?.identitySource === "dev-header" ? (
          <button className="role" type="button" onClick={() => setAuthState("anon")}>
            Gerçek giriş
          </button>
        ) : (
          <button
            className="role"
            type="button"
            onClick={() => {
              void fetch("/api/auth/logout", { method: "POST" }).then(() => {
                setSession(null);
                newConversation();
                setAuthState("anon");
              });
            }}
          >
            Çıkış
          </button>
        )}
      </header>

      {showAdmin && session && (
        <AdminPanel
          selfId={session.userId}
          onClose={() => setShowAdmin(false)}
          api={adminApi(role)}
        />
      )}

      {history !== null && (
        <>
          {/* Dışına tıklayınca kapanır: her panelin bir X'i olması gerekmez. */}
          <div className="scrim" onClick={() => setHistory(null)} aria-hidden />
          <aside className="history" aria-label="Geçmiş konuşmalar">
            <div className="history-head">Konuşmalar</div>
            {history.length === 0 ? (
              <p className="history-empty">Henüz konuşma yok.</p>
            ) : (
              <div className="history-list">
                {history.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className={`history-item${c.id === conversationId ? " on" : ""}`}
                    onClick={() => void loadConversation(c.id)}
                  >
                    <span className="t">{c.title}</span>
                    <span className="d">
                      {new Date(c.updatedAt).toLocaleDateString("tr-TR", {
                        day: "numeric",
                        month: "short",
                      })}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </aside>
        </>
      )}

      <div className={`stage${panels.length ? " shifted" : ""}`} ref={stageRef}>
        <div className="col">
          {!chatting && (
            <div className="hero">
              <div className="kicker in" style={{ animationDelay: ".05s" }}>
                {new Date().toLocaleDateString("tr-TR", { day: "numeric", month: "long" })}
              </div>
              <h1 className="greet in" style={{ animationDelay: ".12s" }}>
                Günaydın Cebrail Bey.
                <br />
                <em>Ne öğrenmek istersiniz?</em>
              </h1>
            </div>
          )}

          {!chatting && briefing && briefing.signals.length > 0 && (
            <Signals signals={briefing.signals} onAsk={(q) => void ask(q)} />
          )}

          <div className="stream">
            {turns.map((t, i) => (
              <div className="turn" key={i}>
                <div className="ask">{t.question}</div>
                {(t.toolCalls.length > 0 || t.running) && (
                  <div className="calls">
                    {t.toolCalls.map((c, k) => (
                      // Ham tool adı `title`'da: kullanıcıya gösterilmiyor ama
                      // hata ararken elimizden çıkmıyor.
                      <span className={`call${c.ok ? "" : " bad"}`} key={k} title={c.tool}>
                        {toolLabel(c.tool)}
                        {c.ok ? ` · ${formatDuration(c.durationMs)}` : ` · ${c.code}`}
                      </span>
                    ))}
                    {t.running && (
                      <span className="call live" title={t.running}>
                        {toolLabel(t.running)}…
                      </span>
                    )}
                  </div>
                )}
                {t.answer === null ? (
                  <div className="think">
                    <i />
                    <i />
                  </div>
                ) : (
                  <div className="reply">
                    <Reveal text={t.answer} />
                    {visibleRisks(t.risks, t.answer).map((r, k) => (
                      <div className={`risk ${riskClass(r.severity)}`} key={k}>
                        <b>{RISK_LABEL[r.severity] ?? "Not"}</b>
                        <span>{r.message}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>

          <div className="dock">
            {upload && (
              <div className="attach in">
                <span className="attach-name">{upload.filename}</span>
                <span className="attach-meta">
                  {upload.rowCount} satır · {upload.headers.length} sütun
                </span>
                <button
                  type="button"
                  className="attach-x"
                  aria-label="Dosyayı kaldır"
                  onClick={() => {
                    setUpload(null);
                    uploadRef.current = null;
                  }}
                >
                  ×
                </button>
              </div>
            )}
            <div className="composer in" style={{ animationDelay: ".44s" }}>
              <input
                ref={fileRef}
                type="file"
                accept=".csv,.txt,.tsv"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void attachFile(f);
                }}
              />
              <button
                type="button"
                className="clip"
                aria-label="Dosya ekle"
                title="CSV dosyası ekle"
                disabled={uploading}
                onClick={() => fileRef.current?.click()}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M21.4 11.05 12.25 20.2a5.5 5.5 0 0 1-7.78-7.78l9.19-9.19a3.67 3.67 0 0 1 5.19 5.19l-9.2 9.19a1.83 1.83 0 0 1-2.59-2.59l8.49-8.48" />
                </svg>
              </button>
              <textarea
                ref={inputRef}
                rows={1}
                value={value}
                placeholder={
                  upload ? "Bu dosyayla ne yapayım?" : "Şirketinize bir şey sorun…"
                }
                onChange={(e) => {
                  setValue(e.target.value);
                  e.target.style.height = "auto";
                  e.target.style.height = `${Math.min(e.target.scrollHeight, 150)}px`;
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void ask(value);
                  }
                }}
                aria-label="Soru"
              />
              <button
                className={`send${value.trim() ? " on" : ""}`}
                onClick={() => void ask(value)}
                aria-label="Gönder"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 19V5M5 12l7-7 7 7" />
                </svg>
              </button>
            </div>

          </div>
        </div>
        <div className="tail" style={{ height: chatting ? 0 : "18vh" }} />
      </div>

      <aside className={`drawer${panels.length ? " open" : ""}`} aria-label="Paneller">
        <div className="drawer-head">
          <span className="t">Paneller</span>
          <button className="panel-x" onClick={() => setPanels([])} aria-label="Tümünü kapat">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="drawer-body">
          {panels.map((p) => (
            <Panel
              key={p.tool}
              payload={p}
              onClose={() => setPanels((list) => list.filter((x) => x.tool !== p.tool))}
            />
          ))}
        </div>
      </aside>
    </div>
  );
}

/**
 * Sinyal listesi.
 *
 * ÜRÜN KARARI: ana ekranda en fazla İKİ kritik kart açılır.
 *
 * Gerekçe: üç dört kırmızı kart aynı anda açıldığında hiçbiri kritik
 * hissettirmez — Anayasa'nın "kritik olduğunda konuş" ilkesi tam olarak
 * burada ölür. Ama fazlası GİZLENMEZ: kalanlar tek satırda sayıyla
 * duyurulur ve tıklanabilir. Sessizlik, saklamak değildir.
 */
/**
 * Etki rakamını kısaltır: 156000 → "156 bin".
 *
 * Tam rakam kartın yarısını kaplar ve zaten `detail` satırında yazıyor.
 * Buradaki sayı okunmak için değil, BÜYÜKLÜK HİSSİ vermek için var.
 */
const RISK_LABEL: Readonly<Record<string, string>> = {
  critical: "Kritik",
  warning: "Uyarı",
  info: "Bilgi",
};

function riskClass(severity: string): string {
  if (severity === "critical") return "crit";
  if (severity === "info") return "info";
  return "";
}

/**
 * Cevabın içinde zaten geçen uyarıyı tekrar gösterme.
 *
 * Model uyarıyı cümlesine katmışsa, altına aynı cümleyi bir daha koymak
 * kullanıcıya "sistem kendini tekrarlıyor" hissi verir. Katmamışsa satır
 * gerekli — asıl mesele uyarının BİR KEZ görünmesi, hiç görünmemesi değil.
 */
function visibleRisks(risks: readonly TurnRisk[], answer: string | null): readonly TurnRisk[] {
  if (!answer) return risks;
  const haystack = answer.toLocaleLowerCase("tr").replace(/\s+/g, " ");
  return risks.filter((r) => {
    const needle = r.message.toLocaleLowerCase("tr").replace(/\s+/g, " ").replace(/\.$/, "");
    return !haystack.includes(needle);
  });
}

/** Aynı mesaj birden çok tool'dan gelebilir; kullanıcıya bir kez gösterilir. */
function dedupeRisks(risks: readonly TurnRisk[]): TurnRisk[] {
  const seen = new Set<string>();
  return risks.filter((r) => {
    if (seen.has(r.message)) return false;
    seen.add(r.message);
    return true;
  });
}

function formatImpact(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toLocaleString("tr-TR", { maximumFractionDigits: 1 })}M`;
  if (abs >= 1_000) return `${Math.round(value / 1_000)} bin`;
  return value.toLocaleString("tr-TR");
}

function Signals({ signals, onAsk }: { signals: readonly Signal[]; onAsk: (q: string) => void }) {
  const [expandAll, setExpandAll] = useState(false);
  const critical = signals.filter((s) => s.level === 2);
  const quiet = signals.filter((s) => s.level === 1);
  const shown = expandAll ? critical : critical.slice(0, 2);
  const hidden = critical.length - shown.length;

  return (
    <div className="signals">
      {shown.map((sig, i) => (
        <div className="sig2 in" key={sig.id} style={{ animationDelay: `${0.26 + i * 0.09}s` }}>
          <span className="lbl">Kritik</span>
          {/* Başlık ve ölçü aynı satırda: göz önce rakama gider. Ölçü YOKSA
              uydurulmaz — bazı sinyaller sayıya indirgenmez ("kalite kapısı
              bekliyor" gibi) ve sahte bir rakam koymak yanlış aciliyet üretir. */}
          <div className="hd">
            <div className="t">{sig.title}</div>
            {sig.impact !== null && (
              <div className="num">
                {formatImpact(sig.impact)}
                <u>{sig.impactUnit ?? "₺"}</u>
              </div>
            )}
          </div>
          <div className="d">{sig.detail}</div>
          {sig.drilldown && (
            <div className="row">
              <button className="act" onClick={() => onAsk(`${sig.title} Detayını göster.`)}>
                Detayı aç
              </button>
            </div>
          )}
        </div>
      ))}

      {hidden > 0 && (
        <button className="sig-more in" style={{ animationDelay: ".44s" }} onClick={() => setExpandAll(true)}>
          {hidden} kritik konu daha var — göster
        </button>
      )}

      {quiet.map((sig, i) => (
        <div className="sig1 in" key={sig.id} style={{ animationDelay: `${0.44 + i * 0.09}s` }}>
          <i />
          <div>
            <b>{sig.title}</b> <span style={{ opacity: 0.75 }}>· {sig.detail}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Kelime kelime beliriş.
 *
 * DÜRÜSTLÜK NOTU: bu bir sunum efektidir, akış değildir. Metin sunucudan tek
 * parça gelir; buradaki kademeli beliriş okumayı kolaylaştırmak içindir.
 * Gerçek model bağlandığında metin parça parça akacak ve aynı bileşen onu
 * geldiği hızda gösterecek.
 */
function Reveal({ text }: { text: string }) {
  const parts = text.split(/(\s+)/);
  return (
    <div className="txt">
      {parts.map((p, i) =>
        /^\s+$/.test(p) ? (
          p
        ) : (
          <span className="w" key={i} style={{ animationDelay: `${Math.min(i * 0.014, 1.2)}s` }}>
            {p}
          </span>
        ),
      )}
    </div>
  );
}
