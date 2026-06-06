/**
 * UsageGlance — the ONE source for the live provider-usage rendering shared by
 * the sidebar (SidebarUsage) and the idle home (IdleControlCenter). Lifted out of
 * SidebarUsage so both surfaces use a single component + a single data poll
 * shape — no duplicated bar markup, no drift between the two.
 *
 * `ProviderBlock` is the titled claude/codex block (5h + 7d bars + a pace
 * warning). `UsageGlance` is the self-loading section (claude + codex, polled on
 * a 30s interval, hides itself when neither provider has data) used directly by
 * the sidebar; the idle home composes `ProviderBlock` itself so it can lay the
 * two providers out horizontally + quiet.
 *
 * Color thresholds match IdleDashboard's Meter / the chat-pane meters:
 *   accent under ~65% · warning to ~85% · danger above.
 */
import { useEffect, useState } from "react";

import {
  claudeRate,
  codexRate,
  resetIn,
  type ClaudeRate,
  type CodexRate,
} from "../../lib/dashboard";
import { usagePaceRisk, type UsagePaceRisk } from "../../lib/usagePace";
import { reportDiag } from "../../lib/diag";

const FIVE_HOURS = 5 * 3600;
const SEVEN_DAYS = 7 * 24 * 3600;

/** accent < 65% · warning < 85% · danger above — matches IdleDashboard's Meter. */
function barColor(pct: number): string {
  if (pct >= 85) return "var(--color-danger)";
  if (pct >= 65) return "var(--color-warning)";
  return "var(--color-accent)";
}

function UsageBar({
  label,
  pct,
  resetsAt,
  showRemaining = false,
}: {
  label: string;
  pct: number | null;
  resetsAt: number | null;
  showRemaining?: boolean;
}) {
  if (pct == null) return null;
  const clamped = Math.min(Math.max(pct, 0), 100);
  const reset = resetsAt ? resetIn(resetsAt) : "";
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between text-[10px]">
        <span className="font-medium uppercase tracking-widest text-[var(--color-muted)]">{label}</span>
        <span className="flex items-baseline gap-1.5">
          {reset && <span className="text-[var(--color-faint)]">resets {reset}</span>}
          <span className="font-mono text-[var(--color-text-2)]">
            {Math.round(showRemaining ? 100 - pct : pct)}%{showRemaining ? " left" : ""}
          </span>
        </span>
      </div>
      <div className="h-1 w-full overflow-hidden rounded-full bg-[var(--color-panel-2)]">
        <div
          className="h-full rounded-full transition-[width] duration-700"
          style={{ width: `${clamped}%`, background: barColor(pct) }}
        />
      </div>
    </div>
  );
}

function PaceWarning({ risk }: { risk: UsagePaceRisk | null }) {
  if (!risk) return null;
  return (
    <div
      className={`rounded-md border px-2 py-1 text-[10px] leading-snug ${
        risk.level === "danger"
          ? "border-[color-mix(in_srgb,var(--color-danger)_45%,transparent)] bg-[color-mix(in_srgb,var(--color-danger)_12%,transparent)] text-[var(--color-danger)]"
          : "border-[color-mix(in_srgb,var(--color-warning)_45%,transparent)] bg-[color-mix(in_srgb,var(--color-warning)_12%,transparent)] text-[var(--color-warning)]"
      }`}
    >
      <span className="font-medium">{risk.title}</span>
      <span className="text-[var(--color-muted)]"> · {risk.detail}</span>
    </div>
  );
}

function topRisk(...risks: Array<UsagePaceRisk | null>): UsagePaceRisk | null {
  return risks.find((risk) => risk?.level === "danger") ?? risks.find(Boolean) ?? null;
}

/** One provider's titled block (e.g. "claude" / "codex") with its 5h + 7d bars. */
export function ProviderBlock({
  name,
  fiveHour,
  sevenDay,
  showRemaining = false,
}: {
  name: string;
  fiveHour: { pct: number | null; resetsAt: number | null };
  sevenDay: { pct: number | null; resetsAt: number | null };
  showRemaining?: boolean;
}) {
  if (fiveHour.pct == null && sevenDay.pct == null) return null;
  const fiveHourRisk = usagePaceRisk({
    pct: fiveHour.pct,
    resetsAt: fiveHour.resetsAt,
    windowSeconds: FIVE_HOURS,
  });
  const sevenDayRisk = usagePaceRisk({
    pct: sevenDay.pct,
    resetsAt: sevenDay.resetsAt,
    windowSeconds: SEVEN_DAYS,
  });
  const risk = topRisk(fiveHourRisk, sevenDayRisk);
  return (
    <div className="flex flex-col gap-2">
      <span className="text-[10px] font-medium lowercase tracking-wide text-[var(--color-text-2)]">
        {name}
      </span>
      <UsageBar label="5h" pct={fiveHour.pct} resetsAt={fiveHour.resetsAt} showRemaining={showRemaining} />
      <UsageBar label="7d" pct={sevenDay.pct} resetsAt={sevenDay.resetsAt} showRemaining={showRemaining} />
      <PaceWarning risk={risk} />
    </div>
  );
}

/**
 * Hook that polls claude + codex usage every 30s. Shared by both the sidebar and
 * the idle home so they draw from one source. Returns the raw rate shapes plus
 * `hasClaude` / `hasCodex` flags so the caller can hide empty providers.
 */
export function useUsageRates() {
  const [claude, setClaude] = useState<ClaudeRate | null>(null);
  const [codex, setCodex] = useState<CodexRate | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => {
      claudeRate()
        .then((v) => alive && setClaude(v))
        .catch((e) => reportDiag("usage.load", e, { action: "claudeRate" }));
      codexRate()
        .then((v) => alive && setCodex(v))
        .catch((e) => reportDiag("usage.load", e, { action: "codexRate" }));
    };
    load();
    const t = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const hasClaude = !!claude && (claude.fiveHour.pct != null || claude.sevenDay.pct != null);
  const hasCodex = !!codex && (codex.fiveHour.pct != null || codex.sevenDay.pct != null);
  return { claude, codex, hasClaude, hasCodex };
}

/** Sidebar usage section — the narrow stacked claude+codex blocks. */
export function UsageGlance() {
  const { claude, codex, hasClaude, hasCodex } = useUsageRates();
  if (!hasClaude && !hasCodex) return null;

  return (
    <div className="flex flex-col gap-3 border-t border-[var(--color-border)] pt-3">
      <span className="text-[10px] font-medium uppercase tracking-widest text-[var(--color-muted)]">usage</span>
      {hasClaude && (
        <ProviderBlock name="claude" fiveHour={claude!.fiveHour} sevenDay={claude!.sevenDay} showRemaining />
      )}
      {hasCodex && (
        <ProviderBlock name="codex" fiveHour={codex!.fiveHour} sevenDay={codex!.sevenDay} showRemaining />
      )}
    </div>
  );
}
