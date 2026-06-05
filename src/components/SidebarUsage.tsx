/**
 * SidebarUsage — a compact, narrow-sidebar rendering of the user's live usage
 * for codex (ChatGPT-sub primary/secondary windows from ~/.codex logs).
 *
 * Data paths (both already-wired, defensive Tauri commands; see lib/dashboard):
 *   codex  ← codexRate() → codex_usage   (logs_2.sqlite codex.rate_limits)
 *
 * A provider block hides itself when it has no data (e.g. codex before its first
 * desktop/TUI turn), so the section never shows empty bars.
 *
 * Color thresholds match the idle bar: accent under ~65%, warning to ~85%,
 * danger above.
 */
import { useEffect, useState } from "react";

import {
  codexRate,
  resetIn,
  type CodexRate,
} from "../lib/dashboard";
import { usagePaceRisk, type UsagePaceRisk } from "../lib/usagePace";
import { reportDiag } from "../lib/diag";

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

function labelModel(name: string): string {
  if (name === "gpt-5.3-codex-spark") {
    return "gpt-5.3 spark";
  }
  return name;
}

/** One provider's titled block (e.g. "claude" / "codex") with its 5h + 7d bars. */
function ProviderBlock({
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

export function SidebarUsage() {
  const [codex, setCodex] = useState<CodexRate | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => {
      codexRate()
        .then((v) => alive && setCodex(v))
        .catch((e) => reportDiag("sidebar.load", e, { action: "codexRate" }));
    };
    load();
    const t = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const hasCodex = codex && (codex.fiveHour.pct != null || codex.sevenDay.pct != null);
  const sparkKey = codex
    ? Object.keys(codex.models).find(
        (m) => /^gpt-5\.3-codex-spark$/i.test(m),
      )
    : undefined;
  const sparkModel =
    sparkKey && codex?.models[sparkKey] && codex.models[sparkKey].fiveHour.pct != null
      ? sparkKey
      : Object.keys(codex?.models ?? {}).find(
          (m) => codex?.models[m]?.sevenDay?.pct != null && /\bcodex\b/i.test(m),
        );
  const hasSpark = sparkModel != null;
  if (!hasCodex && !hasSpark) return null;

  return (
    <div className="flex flex-col gap-3 border-t border-[var(--color-border)] pt-3">
      <span className="text-[10px] font-medium uppercase tracking-widest text-[var(--color-muted)]">usage</span>
      {hasCodex && (
        <ProviderBlock name="codex" fiveHour={codex!.fiveHour} sevenDay={codex!.sevenDay} showRemaining />
      )}
      {hasSpark && sparkModel && codex?.models[sparkModel] && (
        <ProviderBlock
          name={labelModel(sparkModel)}
          fiveHour={codex.models[sparkModel].fiveHour}
          sevenDay={codex.models[sparkModel].sevenDay}
          showRemaining
        />
      )}
    </div>
  );
}
