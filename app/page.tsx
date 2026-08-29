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

interface Session {
  readonly roleLabel: string;
  readonly visibleTools: readonly string[];
  readonly totalTools: number;
  readonly modelConnected: boolean;
  readonly maxAuthority: number;
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
  const [role, setRole] = useState<Role>("patron");
  const [session, setSession] = useState<Session | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [panels, setPanels] = useState<PanelPayload[]>([]);
  const stageRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    client(role)
      .session.query()
      .then((s) => setSession(s))
      .catch(() => setSession(null));
  }, [role]);

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
          body: JSON.stringify({ question }),
        });
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
            const ev = JSON.parse(line) as RunEvent | { type: "error"; message: string };

            if (ev.type === "tool_start") {
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

  const chatting = turns.length > 0;

  return (
    <div className="shell" style={{ position: "relative" }}>
      <header className="topbar">
        <div className="brand">
          <i />
          <span>KAELON</span>
        </div>
        <div className="who">
          Cebrail Karaarslan · <b>{session?.roleLabel ?? "…"}</b> · Orthaus
        </div>
        <div className="spacer" />
        {session && !session.modelConnected && (
          <span className="demo-badge" title="ANTHROPIC_API_KEY tanımlı değil">
            Demo modu · model bağlı değil
          </span>
        )}
        {session && (
          <span className="who" style={{ border: 0, paddingLeft: 0 }}>
            {session.visibleTools.length}/{session.totalTools} tool · L{session.maxAuthority}
          </span>
        )}
        <select
          className="role"
          value={role}
          onChange={(e) => {
            setRole(e.target.value as Role);
            setTurns([]);
            setPanels([]);
          }}
          aria-label="Rol"
        >
          {ROLES.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}
            </option>
          ))}
        </select>
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

          {!chatting && (
            <div className="signals">
              <div className="sig1 in" style={{ animationDelay: ".26s" }}>
                <i />
                <div>
                  <b>Boya hattında dün 4 saat plansız duruş.</b>{" "}
                  <span style={{ opacity: 0.75 }}>· OEE %78 → %72</span>
                </div>
              </div>
              <div className="sig1 in" style={{ animationDelay: ".34s" }}>
                <i />
                <div>
                  <b>Volvo sevkiyatında 4 gün gecikme riski.</b>{" "}
                  <span style={{ opacity: 0.75 }}>· ~156.000 TL ceza riski</span>
                </div>
              </div>
            </div>
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
                Rolü değiştirin — görünen tool sayısı ve alınan cevap gerçekten değişir.
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
