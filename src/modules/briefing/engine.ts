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
}

export interface BriefingDeps {
  readonly registry: ToolRegistry;
  readonly audit: AuditSink;
  readonly sentinels?: readonly Sentinel[];
  readonly thresholds?: BriefingThresholds;
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
      const invoked = await invokeTool(sentinel.tool, sentinel.input, {
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

  const level = signals.reduce<SignalLevel>((max, s) => (s.level > max ? s.level : max), 0);

  return {
    level,
    signals,
    ran: eligible.length,
    skippedByPermission: skipped,
    thresholds,
  };
}
