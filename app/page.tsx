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
import type { RunEvent } from "../src/ai/runner.js";

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
  readonly drilldown: { readonly tool: string; readonly input: unknown } | null;
}

interface Session {
  readonly roleLabel: string;
  readonly visibleTools: readonly string[];
  readonly totalTools: number;
  readonly modelConnected: boolean;
  readonly maxAuthority: number;
  readonly identitySource: "session" | "dev-header";
  readonly dataPlane: "demo" | "postgres";
  readonly displayName: string;
}

interface ToolCall { readonly tool: string; readonly ok: boolean; readonly code?: string; readonly durationMs: number }

interface Turn {
  readonly question: string;
  readonly answer: string | null;
  readonly toolCalls: readonly ToolCall[];
  /** Şu an çalışan tool — kullanıcı boş ekrana bakmasın. */
  readonly running: string | null;
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
      setTurns((t) => [...t, { question, answer: null, toolCalls: [], running: null }]);

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
    inputRef.current?.focus();
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
        <div className="brand">
          <i />
          <span>KAELON</span>
        </div>
        <div className="who">
          {session?.displayName ?? "…"} · <b>{session?.roleLabel ?? "…"}</b>
        </div>
        <div className="spacer" />
        {session?.dataPlane === "demo" && (
          <span className="demo-badge" title="İşletmesel veri demo kümesinden geliyor">
            Demo veri
          </span>
        )}

        {session && !session.modelConnected && (
          <span className="demo-badge" title="ANTHROPIC_API_KEY tanımlı değil">
            Model bağlı değil
          </span>
        )}
        {session && (
          <span className="who meta" style={{ border: 0, paddingLeft: 0 }}>
            {session.visibleTools.length}/{session.totalTools} tool · L{session.maxAuthority}
          </span>
        )}
        {/* Konuşma sürüyorsa yeni konuşma açılabilsin; sürmüyorsa buton
            gereksiz gürültüdür. */}
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
                      <span className={`call${c.ok ? "" : " bad"}`} key={k}>
                        {c.tool}
                        {c.ok ? ` · ${c.durationMs}ms` : ` · ${c.code}`}
                      </span>
                    ))}
                    {t.running && <span className="call live">{t.running} çalışıyor…</span>}
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
                  </div>
                )}
              </div>
            ))}
          </div>

          <div className="dock">
            <div className="composer in" style={{ animationDelay: ".44s" }}>
              <textarea
                ref={inputRef}
                rows={1}
                value={value}
                placeholder="Şirketinize bir şey sorun…"
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
            {!chatting && (
              <p className="foot in" style={{ animationDelay: ".52s" }}>
                {/* Rol değiştirme ipucu yalnızca rol seçicisi varken anlamlı;
                    gerçek oturumda rol arayüzden değiştirilemez. */}
                {briefing && briefing.signals.length === 0
                  ? "Bugün eşiği aşan bir şey yok — ekran bilerek sessiz."
                  : session?.identitySource === "dev-header"
                    ? "Rolü değiştirin — görünen sinyaller ve tool sayısı gerçekten değişir."
                    : `${session?.visibleTools.length ?? 0} tool yetkinizde.`}
              </p>
            )}
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
          <span className="lbl">Kritik · müdahale gerekiyor</span>
          <div className="t">{sig.title}</div>
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
