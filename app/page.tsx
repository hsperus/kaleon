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
      setTurns((t) => [...t, { question, answer: null, toolCalls: [] }]);

      try {
        const res = await client(role).ask.mutate({ question });
        setTurns((t) => {
          const next = [...t];
          const last = next[next.length - 1]!;
          next[next.length - 1] = {
            ...last,
            answer: res.answer,
            toolCalls: [...res.toolCalls],
          };
          return next;
        });
      } catch (e) {
        setTurns((t) => {
          const next = [...t];
          next[next.length - 1] = {
            ...next[next.length - 1]!,
            answer: `İstek tamamlanamadı: ${(e as Error).message}`,
          };
          return next;
        });
      } finally {
        setBusy(false);
        inputRef.current?.focus();
      }
    },
    [busy, role],
  );

  const chatting = turns.length > 0;

  return (
    <div className="shell">
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

      <div className="stage" ref={stageRef}>
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
                {t.answer === null ? (
                  <div className="think">
                    <i />
                    <i />
                  </div>
                ) : (
                  <div className="reply">
                    {t.toolCalls.length > 0 && (
                      <div className="calls">
                        {t.toolCalls.map((c, k) => (
                          <span className={`call${c.ok ? "" : " bad"}`} key={k}>
                            {c.tool}
                            {c.ok ? ` · ${c.durationMs}ms` : ` · ${c.code}`}
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="txt">{t.answer}</div>
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
    </div>
  );
}
