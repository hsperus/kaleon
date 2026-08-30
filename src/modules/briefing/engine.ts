/**
 * Brifing motoru — Boss Mode'un arkasındaki hesap.
 *
 * Nöbetçileri koşturur, sinyalleri toplar ve ekranın "sessizlik seviyesini"
 * belirler. Ekranın doluluğu bir tasarım tercihi değil, bu hesabın çıktısıdır:
 *
 *   Seviye 0 → ekran boş. Sadece selamlama ve giriş alanı.
 *   Seviye 1 → tek satır sessiz uyarı. Rahatsız etmez.
 *   Seviye 2 → kart kendiliğinden açılır. Rakamla, etkiyle.
 *
 * Nöbetçiler NORMAL tool yolundan geçer (`invokeTool`): yetki kontrolü,
 * doğrulama ve audit aynen uygulanır. Brifing için ayrıcalıklı bir yol yoktur —
 * patron da olsa, göremediği veriyi brifingte de göremez.
 */

import { invokeTool } from "../../kernel/invoke.js";
import { missingPermissions } from "../../kernel/rbac.js";
import type { AuditSink } from "../../kernel/audit.js";
import type { ToolRegistry } from "../../kernel/registry.js";
import type { Channel, Principal, TenantContext } from "../../kernel/types.js";
import { evaluateWatch, renderMessage } from "./watch.js";
import type { WatchRow } from "../../db/watch-repository.js";
import {
  DEFAULT_THRESHOLDS,
  SENTINELS,
  type BriefingThresholds,
  type Sentinel,
  type Signal,
  type SignalLevel,
} from "./sentinels.js";

export interface Briefing {
  /** Ekranın sessizlik seviyesi — sinyallerin en yükseği. */
  readonly level: SignalLevel;
  readonly signals: readonly Signal[];
  /** Koşturulan nöbetçi sayısı ve rol nedeniyle atlananlar. */
  readonly ran: number;
  readonly skippedByPermission: readonly string[];
  readonly thresholds: BriefingThresholds;
  /**
   * Çalışamayan izlemeler.
   *
   * SESSİZ KALMAZ: kullanıcı kurduğu izlemenin çalıştığını sanır ve
   * beklediği uyarı hiç gelmezse sisteme değil, kendi hafızasına
   * güvenmemeye başlar.
   */
  readonly brokenWatches: readonly { name: string; reason: string }[];
}

export interface BriefingDeps {
  readonly registry: ToolRegistry;
  readonly audit: AuditSink;
  readonly sentinels?: readonly Sentinel[];
  readonly thresholds?: BriefingThresholds;
  /**
   * Kullanıcı tanımlı izlemeler.
   *
   * Verilmezse yalnızca yerleşik nöbetçiler koşar — izleme deposu
   * olmayan bir kurulumda brifing yine çalışmalıdır.
   */
  readonly watches?: WatchStore;
}

/**
 * İzleme deposunun brifinge bakan yüzü.
 *
 * Arayüz dar tutuluyor: brifing motoru izlemeleri okur ve koşu
 * sonucunu bildirir; oluşturma ve silme onun işi değildir.
 */
export interface WatchStore {
  activeFor(ownerUserId: string): Promise<readonly WatchRow[]>;
  recordCheck(id: string, value: number | null, fired: boolean): Promise<void>;
}

export interface BriefingRequest {
  readonly principal: Principal;
  readonly tenant: TenantContext;
  readonly correlationId: string;
  readonly channel: Channel;
  readonly now?: () => Date;
}

export async function buildBriefing(
  deps: BriefingDeps,
  req: BriefingRequest,
): Promise<Briefing> {
  const thresholds = deps.thresholds ?? DEFAULT_THRESHOLDS;
  const all = deps.sentinels ?? SENTINELS;

  // ROL BAZLI PROAKTİFLİK: izni olmayan role o nöbetçi hiç koşmaz.
  // Bu yalnızca güvenlik değil, davranış kuralıdır — depo sorumlusu nakit
  // uyarısı almamalı, göremediği için değil, alması gerekmediği için.
  const eligible = all.filter((s) => missingPermissions(req.principal, [s.requires]).length === 0);
  const skipped = all.filter((s) => !eligible.includes(s)).map((s) => s.id);

  const results = await Promise.all(
    eligible.map(async (sentinel) => {
      const input =
        typeof sentinel.input === "function"
          ? (sentinel.input as (now: Date) => unknown)((req.now ?? (() => new Date()))())
          : sentinel.input;
      const invoked = await invokeTool(sentinel.tool, input, {
        registry: deps.registry,
        audit: deps.audit,
        principal: req.principal,
        tenant: req.tenant,
        correlationId: req.correlationId,
        channel: req.channel,
        ...(req.now ? { now: req.now } : {}),
      });
      if (!invoked.outcome.ok) return [];
      try {
        return sentinel.evaluate(invoked.outcome.data, thresholds);
      } catch {
        // Bir nöbetçinin patlaması brifingin tamamını düşürmemeli.
        return [];
      }
    }),
  );

  const signals = results
    .flat()
    .filter((s) => s.level > 0)
    .sort((a, b) => {
      if (b.level !== a.level) return b.level - a.level;
      return Math.abs(b.impact ?? 0) - Math.abs(a.impact ?? 0);
    });

  /*
   * ── KULLANICI TANIMLI İZLEMELER ──
   *
   * Yerleşik nöbetçilerle AYNI YOLDAN geçerler: `invokeTool` yetkiyi
   * kontrol eder, girdiyi doğrular ve denetim kaydını yazar. İzleme
   * için ayrıcalıklı bir yol yoktur.
   *
   * SAHİBİNİN KİMLİĞİYLE KOŞAR. Brifingi isteyen kişi ile izlemenin
   * sahibi burada aynı kişidir (`activeFor(req.principal.userId)`);
   * başka birinin izlemesi bu ekranda hiç çalışmaz.
   */
  const watchSignals: Signal[] = [];
  const brokenWatches: { name: string; reason: string }[] = [];

  if (deps.watches) {
    const watches = await deps.watches.activeFor(req.principal.userId);
    await Promise.all(
      watches.map(async (w) => {
        const invoked = await invokeTool(w.tool, w.input, {
          registry: deps.registry,
          audit: deps.audit,
          principal: req.principal,
          tenant: req.tenant,
          correlationId: req.correlationId,
          channel: req.channel,
          ...(req.now ? { now: req.now } : {}),
        });

        if (!invoked.outcome.ok) {
          // Tool çalışmadıysa izleme de çalışmadı; kullanıcı bunu bilmeli.
          brokenWatches.push({
            name: w.name,
            reason: `${w.tool} çalıştırılamadı (${invoked.outcome.code}).`,
          });
          return;
        }

        const outcome = evaluateWatch(w, invoked.outcome.data);
        await deps.watches!.recordCheck(w.id, outcome.value, outcome.fired).catch(() => {
          // Kayıt tutulamazsa izleme yine çalışsın: sinyal kaybolmamalı.
        });

        if (outcome.value === null && outcome.reason) {
          brokenWatches.push({ name: w.name, reason: outcome.reason });
          return;
        }

        if (!outcome.fired) return;

        watchSignals.push({
          id: `watch:${w.id}`,
          level: w.level,
          title: w.name,
          detail: renderMessage(w.message, outcome.value, w.threshold),
          // İzlemenin okuduğu değer parasal olmayabilir (adet, gün);
          // etkiyi para sanmak sıralamayı bozardı.
          impact: null,
          drilldown: { tool: w.tool, input: w.input },
        });
      }),
    );
  }

  const merged = [...signals, ...watchSignals]
    .filter((s) => s.level > 0)
    .sort((a, b) => {
      if (b.level !== a.level) return b.level - a.level;
      return Math.abs(b.impact ?? 0) - Math.abs(a.impact ?? 0);
    });

  const level = merged.reduce<SignalLevel>((max, s) => (s.level > max ? s.level : max), 0);

  return {
    level,
    signals: merged,
    ran: eligible.length + watchSignals.length,
    skippedByPermission: skipped,
    thresholds,
    brokenWatches,
  };
}
