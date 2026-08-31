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
import type { AppRouter } from "../../src/server/router.js";
import { PANEL_TOOLS, Panel, type PanelPayload } from "../panels.js";
import { DocumentSheet } from "../document.js";
import { InvoiceBody, invoiceSheets } from "../invoice-doc.js";
import { DespatchBody, despatchSheets } from "../despatch-doc.js";
import { BalanceSheetBody, balanceSheets, type BalanceSheetView } from "../balance-doc.js";
import { StatementBody, statementSheets, type StatementView } from "../statement-doc.js";
import { PayslipBody, payslipSheets, type PayslipView } from "../payslip-doc.js";
import type { DespatchView, InvoiceView } from "../../src/db/einvoice-repository.js";
import { ActionForm, type PendingAction } from "../action-form.js";
import { RichText } from "../rich-text.js";
import type { Letterhead } from "../../src/modules/documents/letterhead.js";
import { LoginScreen } from "../login.js";
import { AdminPanel } from "../admin.js";
import type { RunEvent } from "../../src/ai/runner.js";
import { formatDuration, toolLabel } from "../../src/ai/tool-labels.js";
import { Welcome, karsilamaGorulduMu, karsilamaGoruldu } from "../welcome.js";

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
  /** Kısa ad — üst çubukta ve dosya adında. */
  readonly companyName: string;
  /** Şirketin hukuki kimliği — dışarı çıkan belgelerin antedi. */
  readonly letterhead: Letterhead | null;
  readonly canManageUsers: boolean;
}

interface ToolCall { readonly tool: string; readonly ok: boolean; readonly code?: string; readonly durationMs: number }

interface TurnRisk {
  readonly severity: string;
  readonly message: string;
}

/**
 * Cevaba iliştirilmiş belge.
 *
 * TÜR AYRI DURUYOR ÇÜNKÜ BELGELER AYNI DEĞİL. Fatura tutar taşır,
 * irsaliye taşımaz; irsaliye plaka taşır, fatura taşımaz. İkisini tek
 * bir "genel belge" tipine sıkıştırmak, her ikisinde de yarısı boş bir
 * form üretirdi.
 */
type AttachedDoc =
  | { readonly kind: "invoice"; readonly invoice: InvoiceView }
  | { readonly kind: "despatch"; readonly despatch: DespatchView }
  | { readonly kind: "balance-sheet"; readonly sheet: BalanceSheetView }
  | { readonly kind: "statement"; readonly statement: StatementView }
  | { readonly kind: "payslip"; readonly payslip: PayslipView };

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
  /**
   * Onay bekleyen işlemler.
   *
   * Turun İÇİNDE durur, ayrı bir kuyrukta değil: form, hangi cümleden
   * doğduğu görünmeden gösterilirse kullanıcı neyi onayladığını bilemez.
   */
  readonly pending: readonly PendingAction[];
  /** Onaylanan işlemlerin sonucu — formun yerini alır. */
  readonly completed: readonly { label: string; ok: boolean; message: string }[];
  /** Şu an çalışan tool — kullanıcı boş ekrana bakmasın. */
  readonly running: string | null;
  /**
   * Modelden akan, henüz tamamlanmamış metin.
   *
   * `answer` ile aynı şey DEĞİLDİR ve olmamalıdır: `answer` bitmiş ve
   * doğrulanmış cevaptır — kopyalanır, dışa aktarılır, geçmişe yazılır.
   * `streaming` ise yazılırken görünen taslaktır ve tur bitince
   * `answer`'a yerini bırakıp silinir. Tek alanda toplansaydı, akış
   * yarıda kesildiğinde yarım bir cevap "cevap" diye kaydedilirdi.
   */
  readonly streaming: string | null;
  /**
   * Bu turda üretilen belgeler.
   *
   * TURUN İÇİNDE DURUR, panelde değil. Panel canlı bir veri
   * göstergesidir ve yenisi geldiğinde eskisinin yerini alır; belge ise
   * o soruya ait, orada kalması gereken bir çıktıdır.
   */
  readonly docs: readonly AttachedDoc[];
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

/**
 * Tool'un girdi şemasını getirir — formun kaynağı.
 *
 * Şema TOOL'UN KENDİSİNDEN gelir; arayüzde ikinci bir form tanımı
 * tutulmaz. Tutulsaydı, tool değişip form değişmediğinde kullanıcı
 * olmayan bir alanı doldurmaya çalışırdı.
 */
async function fetchToolSchema(
  tool: string,
  role: Role,
): Promise<{ label: string; description: string; schema: unknown } | null> {
  try {
    return await client(role).toolSchema.query({ tool });
  } catch {
    // Şema alınamazsa form yerine ham girdi gösterilir; işlem yine
    // onaylanabilir olmalı — onay, formun çalışmasına bağlı değildir.
    return null;
  }
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
  /** Şu an gönderilen onay — düğme iki kez basılmasın. */
  const [confirming, setConfirming] = useState<string | null>(null);
  /**
   * Sayfa açıldığında bulunan, önceki oturumdan kalmış onaylar.
   *
   * Sayfa yenilendiğinde kaybolsalardı, kullanıcı hazırladığı faturayı
   * bulamaz ve baştan anlatmak zorunda kalırdı — üstelik işlem hâlâ
   * bekliyor olurdu ve iki kez hazırlanma riski doğardı.
   */
  const [orphans, setOrphans] = useState<PendingAction[]>([]);
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
  /*
   * KARŞILAMA. Sunucu render'ında `localStorage` yok; başlangıç
   * değeri false ve ilk etkide okunuyor. Doğrudan okunsaydı sunucu ile
   * istemci farklı çıkar ve React uyumsuzluk hatası verirdi.
   */
  const [welcome, setWelcome] = useState(false);
  /*
   * SOHBET ARAMA.
   *
   * Başlıkta ve mesaj içeriğinde arar. Yalnızca başlığa bakmak işe
   * yaramazdı: başlık ilk sorudan türetiliyor ve aranan şey çoğu zaman
   * konuşmanın ortasında geçiyor — "hangi konuşmada Daimler'den
   * bahsetmiştim" sorusu başlıkla cevaplanamaz.
   */
  const [query, setQuery] = useState("");
  /*
   * SATIR İŞLEMLERİ.
   *
   * Başlık ilk sorudan türetiliyor ve çoğu zaman işe yarıyor — ama
   * "selam" diye başlayan bir konuşma iki gün sonra bulunamaz. Silme
   * ve yeniden adlandırma bu yüzden var.
   *
   * SİLME ONAY İSTER ama tarayıcının `confirm()` kutusuyla değil:
   * satırın kendisi soruyu soruyor, çünkü hangi satırı sildiğini
   * görmek onayın yarısıdır.
   */
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [hits, setHits] = useState<
    { id: string; title: string; updatedAt: string; snippet: string | null }[] | null
  >(null);
  useEffect(() => {
    if (authState === "in" && !karsilamaGorulduMu()) setWelcome(true);
  }, [authState]);
  /*
   * GENİŞ EKRANDA GEÇMİŞ ÖRTÜ DEĞİL, SÜTUNDUR.
   *
   * Konuşma listesi bir çekmecedeyken kimse açmıyordu; açmak için önce
   * var olduğunu bilmek gerekiyordu. Yer varken sürekli dursun.
   * Dar ekranda yer yok — orada eski davranış, örtü olarak kalır.
   */
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1100px)");
    const sync = () => setWide(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

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

  // Açılışta bekleyen onayları getir.
  useEffect(() => {
    let alive = true;
    client(role)
      .pendingActions.query()
      .then((rows) => {
        if (!alive) return;
        setOrphans(
          rows.map((r) => ({
            pendingId: r.id,
            tool: r.tool,
            label: r.label,
            description: r.description,
            input: r.input,
            authority: r.authority,
            schema: (r.schema as never) ?? null,
          })),
        );
      })
      .catch(() => setOrphans([]));
    return () => {
      alive = false;
    };
  }, [role, reloadKey]);

  /*
   * EN ALTA İN — AMA YERLEŞİM OTURDUKTAN SONRA.
   *
   * Önce doğrudan `scrollTo` çağrılıyordu ve etki, tablo/kart
   * yerleşmeden önce koşuyordu: `scrollHeight` henüz eski değerdeydi
   * ve kaydırma hiçbir şey yapmıyordu. Konuşma açıldığında ekran en
   * üstte kalıyor, son cevabı görmek için elle aşağı inmek
   * gerekiyordu.
   *
   * ÇİFT `requestAnimationFrame`: ilki React'in DOM'u yazmasını,
   * ikincisi tarayıcının yerleşimi hesaplamasını bekler.
   *
   * AKIŞ SIRASINDA YUMUŞAK, AÇILIŞTA ANİ. Var olan bir konuşmayı
   * açarken yumuşak kaydırma, kullanıcıyı bir saniye boyunca yanlış
   * yere baktırır.
   *
   * `"instant"` KASITLI, `"auto"` DEĞİL. `.stage` üzerinde CSS'te
   * `scroll-behavior: smooth` tanımlı ve `behavior: "auto"` "CSS ne
   * diyorsa onu yap" demek — yani yine yumuşak. Ani kaydırmayı
   * yalnızca `"instant"` garanti eder.
   */
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    let ikinci = 0;
    const ilk = requestAnimationFrame(() => {
      ikinci = requestAnimationFrame(() => {
        el.scrollTo({ top: el.scrollHeight, behavior: busy ? "smooth" : "instant" });
      });
    });
    return () => {
      cancelAnimationFrame(ilk);
      cancelAnimationFrame(ikinci);
    };
  }, [turns, busy]);

  /**
   * Listeyi SESSİZCE tazeler — açık listeyi boşaltmadan.
   *
   * `openHistory` önce `[]` yazıyor ki çekmece "yükleniyor" hâlinde
   * açılsın. Sürekli görünen bir kenar çubuğunda aynı şeyi yapmak,
   * her soru sonrası listenin bir an boşalıp geri gelmesi demek.
   */
  const refreshHistory = useCallback(async () => {
    try {
      const rows = await client(role).conversations.query();
      setHistory((eski) => (eski === null ? eski : [...rows]));
    } catch {
      // Tazeleme başarısızsa eski liste durur; boşaltmak daha kötü.
    }
  }, [role]);

  /*
   * Yazdıkça arar ama HER TUŞTA DEĞİL: 220 ms sessizlikten sonra.
   * Her tuşta sorgu atmak, "Daimler" yazarken yedi ayrı arama demek —
   * altısının sonucu daha gelmeden geçersiz oluyor.
   */
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setHits(null);
      return;
    }
    let iptal = false;
    const t = setTimeout(() => {
      client(role)
        .searchConversations.query({ query: q })
        .then((rows) => {
          if (!iptal) setHits([...rows]);
        })
        .catch(() => {
          if (!iptal) setHits([]);
        });
    }, 220);
    return () => {
      iptal = true;
      clearTimeout(t);
    };
  }, [query, role]);

  const ask = useCallback(
    async (question: string) => {
      if (!question.trim() || busy) return;
      setBusy(true);
      setValue("");
      setTurns((t) => [
        ...t,
        { question, answer: null, toolCalls: [], risks: [], running: null, streaming: null, pending: [], completed: [], docs: [] },
      ]);

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
              /*
               * AKAN METİN TOOL BAŞLAYINCA TEMİZLENİR.
               *
               * Model önce "bakıyorum, önce açık faturaları çekeyim"
               * gibi bir cümle yazıp sonra tool çağırıyor. O cümle
               * ekranda kalsaydı, gelen asıl cevabın önüne yapışır ve
               * kullanıcı iki farklı cevabı arka arkaya okurdu.
               */
              patch((t) => ({ ...t, running: ev.tool, streaming: "" }));
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
              // Belge cevabın yanına iliştirilir.
              const doc = asAttachedDoc(ev.ok ? ev.data : undefined);
              if (doc) {
                const key = docKey(doc);
                patch((t) => ({
                  ...t,
                  // Aynı belge iki kez sorulursa iki kart çıkmasın.
                  docs: [...t.docs.filter((d) => docKey(d) !== key), doc],
                }));
              }
              if (ev.ok && PANEL_TOOLS.has(ev.tool) && ev.data !== undefined) {
                setPanels((p) => [
                  { tool: ev.tool, data: ev.data, sources: ev.sources ?? [] },
                  ...p.filter((x) => x.tool !== ev.tool),
                ]);
              }
            } else if (ev.type === "pending") {
              // ONAY BEKLEYEN İŞLEM HATA DEĞİLDİR: tool listesine
              // "başarısız" olarak düşmez, formu açar.
              const p = ev as unknown as {
                tool: string;
                pendingId: string;
                input: unknown;
                authority: number;
              };
              const meta = await fetchToolSchema(p.tool, role);
              patch((t) => ({
                ...t,
                running: null,
                pending: [
                  ...t.pending,
                  {
                    pendingId: p.pendingId,
                    tool: p.tool,
                    label: meta?.label ?? p.tool,
                    description: meta?.description ?? null,
                    input: p.input,
                    authority: p.authority,
                    schema: (meta?.schema as never) ?? null,
                  },
                ],
              }));
            } else if (ev.type === "self_check") {
              /*
               * ÖZ-DENETİM UYARISI RİSK LİSTESİNE GİRER AMA KAYNAĞI
               * FARKLIDIR: tool riskleri o tool'un söylediği şeydir,
               * bu ise sistemin cevaba itirazıdır. Aynı listede
               * gösteriliyor çünkü kullanıcı için ikisi de "dikkat
               * et" demek — ama metin kimin konuştuğunu söylüyor.
               */
              patch((t) => ({
                ...t,
                risks: dedupeRisks([...t.risks, { severity: ev.severity, message: ev.message }]),
              }));
            } else if (ev.type === "text_delta") {
              // Parça parça yaz: ilk kelime saniyeler önce görünsün.
              patch((t) => ({ ...t, streaming: (t.streaming ?? "") + ev.text }));
            } else if (ev.type === "text") {
              // Tam metin YETKİLİDİR: akış yarım kalmış olabilir.
              patch((t) => ({ ...t, answer: ev.text, streaming: null, running: null }));
            } else if (ev.type === "error") {
              patch((t) => ({
                ...t,
                answer: `İstek tamamlanamadı: ${ev.message}`,
                streaming: null,
                running: null,
              }));
            }
          }
        }
      } catch (e) {
        patch((t) => ({ ...t, answer: `İstek tamamlanamadı: ${(e as Error).message}`, running: null }));
      } finally {
        setBusy(false);
        inputRef.current?.focus();
        /*
         * GEÇMİŞİ TAZELE.
         *
         * Konuşma sunucuda ilk soruda oluşuyor ama kenar çubuğu
         * açılışta bir kez yükleniyordu. Kullanıcı soru soruyor,
         * "Yeni sohbet"e basıyor ve eskisi listede GÖRÜNMÜYORDU —
         * kaybolduğunu sanıyordu. Kayıt duruyordu; liste bayattı.
         */
        void refreshHistory();
      }
    },
    [busy, role, refreshHistory],
  );

  /**
   * Onay bekleyen işlemi çalıştırır.
   *
   * Form kapanır ve YERİNE SONUÇ GELİR: "onayladım, ne oldu?" sorusu
   * ekranda cevapsız kalmamalıdır.
   */
  const confirmAction = useCallback(
    async (turnIndex: number, action: PendingAction, input: unknown) => {
      setConfirming(action.pendingId);
      try {
        const res = await client(role).confirmAction.mutate({
          pendingId: action.pendingId,
          input,
        });
        const ok = res.outcome.ok;
        // Tool kendi sonucunu anlatıyorsa onu kullan; anlatmıyorsa
        // geçmiş zamanlı etiket yeter. "Stok hareketi kaydedildi
        // tamamlandı" gibi iki kez çekimlenmiş bir cümle kurulmamalı.
        const message = ok
          ? ((res.outcome as unknown as { risks?: readonly { message: string }[] }).risks?.[0]
              ?.message ?? `${res.label}.`)
          : (res.outcome as unknown as { message: string }).message;

        setTurns((list) => {
          const next = [...list];
          const t = next[turnIndex];
          if (!t) return list;
          next[turnIndex] = {
            ...t,
            // Başarısızsa form AÇIK KALIR: kullanıcı bir alanı düzeltip
            // yeniden gönderebilmeli, formu baştan doldurmamalı.
            pending: ok ? t.pending.filter((p) => p.pendingId !== action.pendingId) : t.pending,
            completed: [...t.completed, { label: res.label, ok, message }],
          };
          return next;
        });
      } catch (e) {
        setTurns((list) => {
          const next = [...list];
          const t = next[turnIndex];
          if (!t) return list;
          next[turnIndex] = {
            ...t,
            completed: [
              ...t.completed,
              { label: action.label, ok: false, message: (e as Error).message },
            ],
          };
          return next;
        });
      } finally {
        setConfirming(null);
      }
    },
    [role],
  );

  const cancelAction = useCallback(
    async (turnIndex: number, action: PendingAction) => {
      await client(role).cancelAction.mutate({ pendingId: action.pendingId }).catch(() => null);
      setTurns((list) => {
        const next = [...list];
        const t = next[turnIndex];
        if (!t) return list;
        next[turnIndex] = {
          ...t,
          pending: t.pending.filter((p) => p.pendingId !== action.pendingId),
          completed: [...t.completed, { label: action.label, ok: false, message: "Vazgeçildi; hiçbir kayıt oluşmadı." }],
        };
        return next;
      });
    },
    [role],
  );

  /** Konuşma dışında duran bekleyen onay — aynı akış, ayrı yer. */
  const resolveOrphan = useCallback(
    async (action: PendingAction, input: unknown | null) => {
      setConfirming(action.pendingId);
      try {
        if (input === null) {
          await client(role).cancelAction.mutate({ pendingId: action.pendingId });
        } else {
          await client(role).confirmAction.mutate({ pendingId: action.pendingId, input });
        }
        setOrphans((list) => list.filter((o) => o.pendingId !== action.pendingId));
      } finally {
        setConfirming(null);
      }
    },
    [role],
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
    // Az önceki konuşma listeye girsin: kullanıcı "nereye gitti"
    // diye sormadan önce orada olmalı.
    void refreshHistory();
  }, [refreshHistory]);

  const renameConversation = useCallback(
    async (id: string, title: string) => {
      const t = title.trim();
      setRenaming(null);
      if (t.length === 0) return;
      // İYİMSER GÜNCELLEME: liste anında değişir, sunucu arkadan gelir.
      // Yeniden adlandırma geri alınamaz bir şey değil; bir saniyelik
      // gecikme göstermek gereksiz.
      setHistory((eski) => eski?.map((c) => (c.id === id ? { ...c, title: t } : c)) ?? eski);
      try {
        await client(role).renameConversation.mutate({ id, title: t });
      } catch {
        void refreshHistory();
      }
    },
    [role, refreshHistory],
  );

  const deleteConversation = useCallback(
    async (id: string) => {
      setConfirmDelete(null);
      setHistory((eski) => eski?.filter((c) => c.id !== id) ?? eski);
      // Açık olan konuşma silindiyse ekran da boşalmalı: silinmiş bir
      // konuşmayı okumaya devam etmek yanıltıcı olur.
      if (conversationIdRef.current === id) {
        conversationIdRef.current = null;
        setConversationId(null);
        setTurns([]);
        setPanels([]);
      }
      try {
        await client(role).deleteConversation.mutate({ id });
      } catch {
        void refreshHistory();
      }
    },
    [role, refreshHistory],
  );

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

  // Sütun hâlindeyken liste boş duramaz; açılışta bir kez yüklenir.
  useEffect(() => {
    if (wide) void openHistory();
  }, [wide, openHistory]);

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
            // Geçmiş tur akmıyor: cevabı zaten tamamlanmış.
            streaming: null,
            pending: [],
            completed: [],
            // Geçmiş konuşmada belge yeniden kurulmaz: fatura o andaki
            // hâliyle saklanmadığı için eski bir görüntüyü "güncel
            // fatura" gibi göstermek yanlış olur. Soru tekrar
            // sorulduğunda belge yeniden üretilir.
            docs: [],
          })),
        );
        setPanels([]);
        /*
         * ÇEKMECEYİ KAPAT — AMA YALNIZCA ÇEKMECEYSE.
         *
         * Dar ekranda geçmiş bir örtüdür ve seçim yapılınca kapanmalı.
         * Geniş ekranda ise KALICI SÜTUNDUR: `null` yazmak sütunu
         * tamamen yok ediyordu ve hamburger de o genişlikte gizli
         * olduğu için bir daha geri gelmiyordu. Kullanıcı bir
         * konuşmaya tıklıyor ve geçmişi kaybediyordu.
         */
        if (!wide) setHistory(null);
      } catch {
        // Konuşma silinmiş veya başkasına ait: listeyi tazele.
        void openHistory();
      }
    },
    [role, openHistory, wide],
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
      {welcome && (
        <Welcome
          name={session?.displayName ?? ""}
          onDone={() => {
            karsilamaGoruldu();
            setWelcome(false);
          }}
        />
      )}
      <header className="topbar">
        {/* Üst çubuk tam genişlikte olduğu için marka soldaki sütunun
            tam üstüne denk gelir; kenar çubuğuna ikinci bir başlık
            koymaya gerek yok. Kimlik ise oraya, ayak kısmına taşındı. */}
        <div className="brand">KAELON</div>
        {!wide && (
          <div className="who">
            {session?.displayName ?? "…"} · <b>{session?.roleLabel ?? "…"}</b>
          </div>
        )}
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
        {/* Geniş ekranda geçmiş zaten sütun hâlinde duruyor; açıp
            kapatacak bir şey yok. `hidden` niteliği YETMEZ: `.icon-btn`
            kuralı `display: flex` diyor ve tarayıcının `[hidden]`
            varsayılanını eziyor — düğme gizlenmiş sanılırken tıklanabilir
            kalıyordu. */}
        {!wide && (
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
        )}
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
          {/* Dışına tıklayınca kapanır: her panelin bir X'i olması gerekmez.
              Sütun hâlindeyken kapanacak bir şey yok, örtü de yok. */}
          {!wide && <div className="scrim" onClick={() => setHistory(null)} aria-hidden />}
          <aside className="history" aria-label="Geçmiş konuşmalar">
            <div className="history-new">
              <button type="button" onClick={newConversation}>
                <span aria-hidden>+</span> Yeni sohbet
              </button>
            </div>

            <div className="history-search">
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Sohbetlerde ara"
                placeholder="Sohbetlerde ara"
              />
            </div>
            {hits !== null ? (
              <div className="history-list">
                <div className="history-head">
                  {hits.length === 0 ? "SONUÇ YOK" : `${hits.length} SONUÇ`}
                </div>
                {hits.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className={`history-item hit${c.id === conversationId ? " on" : ""}`}
                    onClick={() => void loadConversation(c.id)}
                  >
                    <span className="t">{c.title}</span>
                    {/* Neden eşleştiğini göstermeyen bir sonuç listesi
                        rastgele görünür. */}
                    {c.snippet && <span className="s">{c.snippet}</span>}
                  </button>
                ))}
                {hits.length === 0 && (
                  <p className="history-empty">
                    &ldquo;{query.trim()}&rdquo; hiçbir sohbette geçmiyor.
                  </p>
                )}
              </div>
            ) : history.length === 0 ? (
              <>
                <div className="history-head">KONUŞMALAR</div>
                <p className="history-empty">Henüz konuşma yok.</p>
              </>
            ) : (
              <div className="history-list">
                {/* Her satırda tarih yazmak yerine gün başlıkları.
                    Aynı güne ait yirmi satırda yirmi kez "29 Ağu" okumak
                    bilgi değil gürültüdür; başlık bir kez söyler. */}
                {groupByDay(history).map((g) => (
                  <div key={g.label}>
                    <div className="history-head">{g.label}</div>
                    {g.items.map((c) =>
                      renaming === c.id ? (
                        /* Yeniden adlandırma SATIRIN YERİNDE olur:
                           ayrı bir kutu açmak, hangi konuşmayı
                           adlandırdığını gözden kaçırtır. */
                        <form
                          key={c.id}
                          className="history-rename"
                          onSubmit={(e) => {
                            e.preventDefault();
                            void renameConversation(c.id, renameValue);
                          }}
                        >
                          <input
                            autoFocus
                            value={renameValue}
                            maxLength={120}
                            onChange={(e) => setRenameValue(e.target.value)}
                            onBlur={() => void renameConversation(c.id, renameValue)}
                            onKeyDown={(e) => {
                              if (e.key === "Escape") setRenaming(null);
                            }}
                            aria-label="Konuşma adı"
                          />
                        </form>
                      ) : confirmDelete === c.id ? (
                        /* Onayı satırın kendisi soruyor: hangi satırı
                           sildiğini görmek onayın yarısıdır. */
                        <div key={c.id} className="history-confirm">
                          <span>Silinsin mi?</span>
                          <button type="button" onClick={() => setConfirmDelete(null)}>
                            Vazgeç
                          </button>
                          <button
                            type="button"
                            className="yes"
                            onClick={() => void deleteConversation(c.id)}
                          >
                            Sil
                          </button>
                        </div>
                      ) : (
                        <div
                          key={c.id}
                          className={`history-row${c.id === conversationId ? " on" : ""}`}
                        >
                          <button
                            type="button"
                            className="history-item"
                            onClick={() => void loadConversation(c.id)}
                          >
                            <span className="t">{c.title}</span>
                          </button>
                          <span className="history-acts">
                            <button
                              type="button"
                              title="Yeniden adlandır"
                              aria-label={`${c.title} — yeniden adlandır`}
                              onClick={() => {
                                setRenameValue(c.title);
                                setRenaming(c.id);
                              }}
                            >
                              <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden>
                                <path
                                  d="M11.5 2.5 13.5 4.5 5.5 12.5 3 13 3.5 10.5z"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="1.3"
                                  strokeLinejoin="round"
                                />
                              </svg>
                            </button>
                            <button
                              type="button"
                              title="Sil"
                              aria-label={`${c.title} — sil`}
                              onClick={() => setConfirmDelete(c.id)}
                            >
                              <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden>
                                <path
                                  d="M3.5 4.5h9M6.5 4.5V3h3v1.5M5 4.5l.5 8h5l.5-8"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="1.3"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                />
                              </svg>
                            </button>
                          </span>
                        </div>
                      ),
                    )}
                  </div>
                ))}
              </div>
            )}
            {wide && session && (
              <div className="history-foot">
                <span className="av" aria-hidden>
                  {initials(session.displayName)}
                </span>
                <span className="id">
                  <b>{session.displayName}</b>
                  <span>
                    {session.roleLabel}
                    {session.companyName ? ` · ${session.companyName}` : ""}
                  </span>
                </span>
              </div>
            )}
          </aside>
        </>
      )}

      {/*
        ALT BAR KAYDIRMA ALANININ DIŞINDA.
        Önce `.stage` içindeydi ve mesajlarla birlikte yukarı kayıyordu:
        uzun bir cevabın ortasında soru sormak için önce en alta inmek
        gerekiyordu. Yazma alanı her zaman aynı yerde durmalı.
      */}
      <div className="main">
      <div
        className={`stage${panels.length ? " shifted" : ""}${chatting ? "" : " welcome"}`}
        ref={stageRef}
      >
        <div className="col">
          {!chatting && (
            <div className="hero">
              <div className="kicker in" style={{ animationDelay: ".05s" }}>
                {new Date().toLocaleDateString("tr-TR", { day: "numeric", month: "long" })}
              </div>
              <h1 className="greet in" style={{ animationDelay: ".12s" }}>
                {greeting(session?.displayName)}
                <br />
                <em>Neyi merak ediyorsunuz?</em>
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
                  /*
                   * AKIŞ VARSA NOKTALAR DEĞİL METİN GÖSTERİLİR.
                   *
                   * Üç zıplayan nokta "bir şey oluyor" der; akan metin
                   * NE olduğunu söyler. Cevap henüz bitmediği için
                   * imleç yanıp söner ve zengin biçimlendirme
                   * uygulanmaz — yarım bir markdown tablosu, tamamlanana
                   * kadar bozuk görünürdü.
                   */
                  t.streaming ? (
                    <div className="reply">
                      <p className="drafting">
                        {t.streaming}
                        <span className="caret" />
                      </p>
                    </div>
                  ) : (
                    <div className="think">
                      <i />
                      <i />
                    </div>
                  )
                ) : (
                  <div className="reply">
                    <RichText
                      text={t.answer}
                      org={session?.companyName ?? "İşletme"}
                      letterhead={session?.letterhead ?? null}
                      question={t.question}
                    />
                    {visibleRisks(t.risks, t.answer).map((r, k) => (
                      <div className={`risk ${riskClass(r.severity)}`} key={k}>
                        <b>{RISK_LABEL[r.severity] ?? "Not"}</b>
                        <span>{r.message}</span>
                      </div>
                    ))}
                  </div>
                )}

                {t.docs.map((d) => (
                  <DocCard key={docKey(d)} doc={d} org={session?.companyName ?? "İşletme"} />
                ))}

                {t.completed.map((c, k) => (
                  <div className={`done-row${c.ok ? "" : " bad"}`} key={`d${k}`}>
                    <b>{c.ok ? "Tamamlandı" : "Yapılmadı"}</b>
                    <span>{c.message}</span>
                  </div>
                ))}

                {t.pending.map((p) => (
                  <ActionForm
                    key={p.pendingId}
                    action={p}
                    busy={confirming === p.pendingId}
                    onConfirm={(input) => void confirmAction(i, p, input)}
                    onCancel={() => void cancelAction(i, p)}
                  />
                ))}
              </div>
            ))}
          </div>

          {orphans.length > 0 && (
            <div className="orphans">
              <p className="orphan-note">
                Önceki oturumdan kalan {orphans.length} işlem onayınızı bekliyor.
              </p>
              {orphans.map((o) => (
                <ActionForm
                  key={o.pendingId}
                  action={o}
                  busy={confirming === o.pendingId}
                  onConfirm={(input) => void resolveOrphan(o, input)}
                  onCancel={() => void resolveOrphan(o, null)}
                />
              ))}
            </div>
          )}

        </div>
        <div className="tail" style={{ height: chatting ? 0 : "18vh" }} />
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
              /* Boş kutuda yer tutucu yok: imleç zaten orada yanıp
                 sönüyor ve ne yapılacağı belli. Dosya eklendiğinde
                 ise gerçekten bir soru var — o zaman yazıyor. */
              {...(upload ? { placeholder: "Bu dosyayla ne yapayım?" } : {})}
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
/** Belgenin kimliği — aynı belgenin iki kez iliştirilmesini önler. */
function docKey(d: AttachedDoc): string {
  if (d.kind === "invoice") return `f:${d.invoice.documentNo}`;
  if (d.kind === "despatch") return `i:${d.despatch.documentNo}`;
  if (d.kind === "statement") return `m:${d.statement.partnerId}:${d.statement.to}`;
  if (d.kind === "payslip") return `p:${d.payslip.employeeCode}:${d.payslip.period}`;
  return `b:${d.sheet.asOf}`;
}

/**
 * Belgenin cevabın altındaki kartı.
 *
 * BELGE KENDİLİĞİNDEN AÇILMAZ. Kullanıcı "şu faturayı göster" dediğinde
 * ekranı kaplayan bir katman açmak, cevabı okumasını engeller ve
 * kontrolü elinden alır; kart görünür, açmaya o karar verir.
 */
function DocCard({ doc, org }: { doc: AttachedDoc; org: string }) {
  const [open, setOpen] = useState(false);
  const tl = (n: number): string =>
    new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 0 }).format(n);

  // Her belgenin kartında onu AYIRT EDEN şey yazar: faturada tutar,
  // irsaliyede plaka, bilançoda denklik.
  const view =
    doc.kind === "invoice"
      ? {
          no: doc.invoice.documentNo,
          title: `Fatura ${doc.invoice.documentNo}`,
          who: doc.invoice.customer.legalName,
          detail: new Intl.NumberFormat("tr-TR", {
            style: "currency",
            currency: doc.invoice.currency,
          }).format(doc.invoice.totalAmount),
          flag:
            doc.invoice.status !== "issued" && doc.invoice.status !== "paid" ? "taslak" : null,
          sheets: invoiceSheets(doc.invoice),
          body: <InvoiceBody inv={doc.invoice} />,
        }
      : doc.kind === "despatch"
        ? {
            no: doc.despatch.documentNo,
            title: `İrsaliye ${doc.despatch.documentNo}`,
            who: doc.despatch.customer.legalName,
            detail: `${doc.despatch.lines.length} kalem${doc.despatch.plateNo ? ` · ${doc.despatch.plateNo}` : ""}`,
            flag: doc.despatch.status !== "posted" ? "taslak" : null,
            sheets: despatchSheets(doc.despatch),
            body: <DespatchBody d={doc.despatch} />,
          }
        : doc.kind === "payslip"
        ? {
            no: doc.payslip.employeeCode,
            title: `Bordro ${doc.payslip.employeeName} ${doc.payslip.period.slice(0, 7)}`,
            who: doc.payslip.employeeName,
            detail: `Net ${tl(doc.payslip.netSalary)} · ${doc.payslip.period.slice(0, 7)}`,
            flag: null,
            sheets: payslipSheets(doc.payslip),
            body: <PayslipBody p={doc.payslip} />,
          }
        : doc.kind === "statement"
        ? {
            no: "Mutabakat",
            title: `Mutabakat ${doc.statement.partnerName}`,
            who: doc.statement.partnerName,
            detail: `${tl(Math.abs(doc.statement.closingBalance))} ${
              doc.statement.closingBalance >= 0 ? "borç" : "alacak"
            } · ${doc.statement.movements.length} hareket`,
            flag: null,
            sheets: statementSheets(doc.statement),
            body: <StatementBody s={doc.statement} />,
          }
        : {
            no: "Bilanço",
            title: `Bilanço ${doc.sheet.asOf.slice(0, 10)}`,
            who: doc.sheet.asOf.slice(0, 10),
            detail: `Aktif ${tl(doc.sheet.totalAssets)} · Pasif ${tl(doc.sheet.totalLiabilities)}`,
            // DENK DEĞİLSE KARTTA GÖRÜNÜR: açmadan önce bilinmeli.
            flag: doc.sheet.balanced ? null : "DENK DEĞİL",
            sheets: balanceSheets(doc.sheet),
            body: <BalanceSheetBody b={doc.sheet} />,
          };

  return (
    <>
      <button type="button" className="doc-card" onClick={() => setOpen(true)}>
        <span className="doc-card-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="M6 2h8l4 4v16H6z" strokeLinejoin="round" />
            <path d="M14 2v4h4" strokeLinejoin="round" />
            <path d="M9 12h6M9 16h6" strokeLinecap="round" />
          </svg>
        </span>
        <span className="doc-card-text">
          <b>{view.no}</b>
          <span>
            {view.who} · {view.detail}
            {view.flag ? ` · ${view.flag}` : ""}
          </span>
        </span>
        <span className="doc-card-go">Belgeyi aç</span>
      </button>
      {open && (
        <DocumentSheet
          meta={{ title: view.title, org, question: view.who }}
          sheets={view.sheets}
          onClose={() => setOpen(false)}
        >
          {view.body}
        </DocumentSheet>
      )}
    </>
  );
}

/**
 * Tool sonucunu belgeye çevirir.
 *
 * KÖRÜ KÖRÜNE CAST EDİLMEZ. Sunucudan gelen veri bir gün biçim
 * değiştirirse, `as InvoiceView` demek arayüzü çalışma anında patlatır;
 * burada beklenen alanlar KONTROL EDİLİR ve uymuyorsa belge hiç
 * gösterilmez — cevabın kendisi yine görünür.
 */
export function asAttachedDoc(data: unknown): AttachedDoc | null {
  if (typeof data !== "object" || data === null) return null;
  const d = data as { kind?: unknown; invoice?: unknown; despatch?: unknown; payslip?: unknown };

  if (d.kind === "invoice" && typeof d.invoice === "object" && d.invoice !== null) {
    const inv = d.invoice as Partial<InvoiceView>;
    if (typeof inv.documentNo !== "string" || !Array.isArray(inv.lines)) return null;
    if (typeof inv.totalAmount !== "number" || typeof inv.currency !== "string") return null;
    if (typeof inv.customer !== "object" || inv.customer === null) return null;
    return { kind: "invoice", invoice: inv as InvoiceView };
  }

  if (d.kind === "despatch" && typeof d.despatch === "object" && d.despatch !== null) {
    const dsp = d.despatch as Partial<DespatchView>;
    if (typeof dsp.documentNo !== "string" || !Array.isArray(dsp.lines)) return null;
    if (typeof dsp.customer !== "object" || dsp.customer === null) return null;
    return { kind: "despatch", despatch: dsp as DespatchView };
  }

  if (d.kind === "payslip" && typeof (d as { payslip?: unknown }).payslip === "object") {
    const ps = (d as { payslip: Partial<PayslipView> }).payslip;
    if (typeof ps.employeeCode !== "string" || typeof ps.netSalary !== "number") return null;
    if (typeof ps.period !== "string" || typeof ps.totalGross !== "number") return null;
    return { kind: "payslip", payslip: { ...ps, kind: "payslip" } as PayslipView };
  }

  // Mutabakat da tool'un data'sının kendisidir.
  if (d.kind === "statement") {
    const st = data as Partial<StatementView>;
    if (typeof st.partnerId !== "string" || !Array.isArray(st.movements)) return null;
    if (typeof st.closingBalance !== "number" || typeof st.openingBalance !== "number") return null;
    return { kind: "statement", statement: st as StatementView };
  }

  // Bilanço tool'un data'sının KENDİSİDİR (ayrı bir alan içinde değil).
  if (d.kind === "balance-sheet") {
    const b = data as Partial<BalanceSheetView>;
    if (!Array.isArray(b.assets) || !Array.isArray(b.liabilities)) return null;
    if (typeof b.totalAssets !== "number" || typeof b.totalLiabilities !== "number") return null;
    if (typeof b.asOf !== "string") return null;
    return { kind: "balance-sheet", sheet: b as BalanceSheetView };
  }

  return null;
}

/**
 * Karşılama cümlesi.
 *
 * ADI DA SAATİ DE SABİT YAZILIYDU: "Günaydın Cebrail Bey." Gece
 * yarısı giren birine günaydın diyordu ve adı ne olursa olsun
 * Cebrail'e sesleniyordu. Demo ortamında bu, kişinin ürünü ilk
 * gördüğü ekranda başkasının adını görmesi demekti.
 *
 * UNVAN EKLENMİYOR. "Bey" yazmak, adından cinsiyet tahmin etmek
 * demektir ve Türkçe adların çoğunda bu tahmin yanlış olabilir.
 * Sadece ilk ad kullanılıyor — hem daha sıcak hem de tahminsiz.
 */
function greeting(displayName: string | undefined): string {
  const h = new Date().getHours();
  const zaman =
    h < 6 ? "İyi geceler" : h < 12 ? "Günaydın" : h < 18 ? "İyi günler" : "İyi akşamlar";

  const ilkAd = (displayName ?? "")
    .trim()
    .split(/\s+/)
    .find((w) => /^\p{L}/u.test(w));

  return ilkAd ? `${zaman}, ${ilkAd}.` : `${zaman}.`;
}

/**
 * Konuşmaları güne göre gruplar.
 *
 * Sıra korunur: liste sunucudan zaten yeniden eskiye gelir, burada
 * yalnızca ardışık aynı-gün satırları tek başlık altında toplanır.
 * Yeniden sıralamak, sunucunun sıralamasını sessizce ezmek olurdu.
 */
function groupByDay(
  rows: readonly { id: string; title: string; updatedAt: string }[],
): { label: string; items: typeof rows }[] {
  const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const today = dayStart(new Date());
  const DAY = 86_400_000;

  const out: { label: string; items: { id: string; title: string; updatedAt: string }[] }[] = [];
  for (const row of rows) {
    const at = new Date(row.updatedAt);
    const diff = today - dayStart(at);
    const label =
      diff <= 0
        ? "BUGÜN"
        : diff === DAY
          ? "DÜN"
          : at
              .toLocaleDateString("tr-TR", { day: "numeric", month: "long" })
              .toLocaleUpperCase("tr-TR");
    const last = out[out.length - 1];
    if (last && last.label === label) last.items.push(row);
    else out.push({ label, items: [row] });
  }
  return out;
}

/**
 * Kenar çubuğu rozeti için baş harfler.
 *
 * İki kelimeden fazlasına bakmaz: "Ali Rıza Kara Ahmetoğlu" için dört
 * harf 30 piksellik daireye sığmaz. Tek kelimelik adda ilk iki harf.
 *
 * HARFLE BAŞLAMAYAN PARÇALAR ATILIR. Demo oturumunda ad
 * "Cebrail Karaarslan (demo)" biçiminde geliyor ve son kelimenin ilk
 * karakteri parantez — rozette "C(" yazıyordu. Ünvan, parantez içi not
 * ya da numara gibi ekler baş harf değildir.
 */
function initials(name: string): string {
  const words = name
    .trim()
    .split(/\s+/)
    .filter((w) => /^\p{L}/u.test(w));
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0]!.slice(0, 2).toLocaleUpperCase("tr-TR");
  return (words[0]![0]! + words[words.length - 1]![0]!).toLocaleUpperCase("tr-TR");
}

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
