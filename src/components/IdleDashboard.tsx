/**
 * IdleDashboard — the entry point for the AIOS home screen (shown when no panes
 * are open). This module is a thin DATA LOADER: it self-loads the cheap,
 * defensive idle data (usage extras / claude rate / memory focus / money-agent
 * summaries / git pulse for recent repos) on a 30s poll and hands it to
 * `IdleControlCenter`, which owns the actual (Option-B) layout.
 *
 * Live lists (oracles / projects / sidebar / notifications) come down as props
 * from App so the home screen and the ⌘K palette share one polled source.
 *
 * It also exports the small ring/heatmap/number formatting primitives reused by
 * PulsePane (the click-to-detail view) so the rich pane matches this surface
 * exactly — those are the only render helpers that survive here.
 */
import { useEffect, useState } from "react";

import type { AppDef } from "../App";
import type { OracleInfo } from "../lib/pty";
import type { ProjectInfo } from "../lib/run";
import type { SidebarState, SidebarItem } from "../lib/sidebar";
import { gitPulse, type RepoPulse } from "../lib/fs";
import { usageExtras, type UsageExtras } from "../lib/stats";
import { loadMoneyAgentSummaries, type MoneyAgentSummary } from "../lib/moneyAgents";
import { pm2List, type Pm2Process } from "../lib/pm2";
import {
  idleRate,
  memoryFocus,
  resetIn,
  type IdleRate,
  type MemoryFocus,
} from "../lib/dashboard";
import type { AiosNotification } from "../lib/notifications";
import { IdleControlCenter } from "./IdleControlCenter";
import { reportDiag } from "../lib/diag";

interface IdleDashboardProps {
  apps: AppDef[];
  oracles: OracleInfo[];
  projects: ProjectInfo[];
  sidebar: SidebarState;
  onSpawn: (kind: AppDef["kind"], label: string) => void;
  onAttachOracle: (identity: string) => void;
  onOpenProject: (p: ProjectInfo) => void;
  onOpenSidebarItem: (item: SidebarItem) => void;
  onRevealSidebar: () => void;
  onOpenMoneyAgents: () => void;
  onOpenMoneyAgentChat: (id: string, label: string, command?: string) => void;
  onOpenPalette: () => void;
  notifications: AiosNotification[];
  onTalkToJarvis: (seed: string) => void;
  onOpenNotificationTarget: (item: AiosNotification) => void;
  onClearNotification: (id: string) => void;
}

export function IdleDashboard({
  projects,
  sidebar,
  onSpawn,
  onOpenProject,
  onOpenSidebarItem,
  onRevealSidebar,
  onOpenMoneyAgents,
  onOpenPalette,
  notifications,
  onTalkToJarvis,
}: IdleDashboardProps) {
  const [extras, setExtras] = useState<UsageExtras | null>(null);
  const [rate, setRate] = useState<IdleRate | null>(null);
  const [focus, setFocus] = useState<MemoryFocus | null>(null);
  const [pulse, setPulse] = useState<RepoPulse[]>([]);
  const [moneyAgents, setMoneyAgents] = useState<MoneyAgentSummary[]>([]);
  const [pm2Processes, setPm2Processes] = useState<Pm2Process[]>([]);

  // Whole-window visibility gate. IdleDashboard only mounts as the full-viewport
  // home screen, so "on screen" == "app window visible" — no IntersectionObserver
  // needed. When AIOS is minimized / occluded these 30s polls (which read sqlite
  // usage, claude rate, memory, money-agent files + `git` per recent repo) would
  // otherwise keep firing into a window nobody's looking at.
  const [windowVisible, setWindowVisible] = useState(
    typeof document === "undefined" ? true : document.visibilityState !== "hidden",
  );
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVis = () => setWindowVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  // top recent projects by dir mtime — also the set the git-pulse reports on.
  // Declared before the effects that read it (TDZ-safe ordering).
  const recent = [...projects].sort((a, b) => b.mtime - a.mtime).slice(0, 6);

  useEffect(() => {
    let alive = true;
    const load = () => {
      usageExtras().then((v) => alive && setExtras(v)).catch((e) => reportDiag("dashboard.load", e, { action: "usageExtras" }));
      idleRate().then((v) => alive && setRate(v)).catch((e) => reportDiag("dashboard.load", e, { action: "idleRate" }));
      memoryFocus().then((v) => alive && setFocus(v)).catch((e) => reportDiag("dashboard.load", e, { action: "memoryFocus" }));
      loadMoneyAgentSummaries().then((v) => alive && setMoneyAgents(v)).catch((e) => reportDiag("dashboard.load", e, { action: "moneyAgents" }));
      pm2List().then((v) => alive && setPm2Processes(v)).catch((e) => reportDiag("dashboard.load", e, { action: "pm2List" }));
    };
    // Always load once on mount (so a freshly-shown home isn't blank), then only
    // poll while the window is visible.
    load();
    if (!windowVisible) return () => { alive = false; };
    const t = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [windowVisible]);

  // git summary for the recent projects (refreshes on the set + 30s, visible only).
  useEffect(() => {
    let alive = true;
    const roots = recent.map((p) => p.root);
    if (!roots.length) {
      setPulse([]);
      return;
    }
    const load = () => gitPulse(roots).then((v) => alive && setPulse(v)).catch((e) => reportDiag("dashboard.load", e, { action: "gitPulse" }));
    load();
    if (!windowVisible) return () => { alive = false; };
    const t = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recent.map((p) => p.root).join("|"), windowVisible]);

  return (
    <IdleControlCenter
      projects={projects}
      sidebar={sidebar}
      extras={extras}
      rate={rate}
      focus={focus}
      pulse={pulse}
      moneyAgents={moneyAgents}
      pm2Processes={pm2Processes}
      notifications={notifications}
      onSpawn={onSpawn}
      onOpenProject={onOpenProject}
      onOpenSidebarItem={onOpenSidebarItem}
      onRevealSidebar={onRevealSidebar}
      onOpenMoneyAgents={onOpenMoneyAgents}
      onOpenPalette={onOpenPalette}
      onTalkToJarvis={onTalkToJarvis}
    />
  );
}

// ── shared render primitives (reused by PulsePane) ───────────────────────────
// These keep PulsePane's rings + heatmap + stat formatting pixel-matched to the
// idle surface. They're the only render helpers that live here now.

function ringColor(pct: number): string {
  if (pct >= 90) return "var(--color-danger)";
  if (pct >= 70) return "var(--color-warning)";
  return "var(--color-accent)";
}

/** An animated %-ring with a centred number + label, used by PulsePane. */
function Ring({
  label,
  pct,
  resetsAt,
  size = 38,
}: {
  label: string;
  pct: number | null;
  resetsAt: number | null;
  size?: number;
}) {
  if (pct == null) return null;
  const r = size / 2 - 6;
  const c = 2 * Math.PI * r;
  const sw = size >= 46 ? 3.5 : 3;
  const filled = Math.min(Math.max(pct, 0), 100) / 100;
  const mid = size / 2;
  return (
    <div className="flex flex-col items-center gap-1">
      <div className="relative grid place-items-center" style={{ height: size, width: size }}>
        <svg viewBox={`0 0 ${size} ${size}`} className="h-full w-full -rotate-90">
          <circle cx={mid} cy={mid} r={r} fill="none" stroke="var(--color-panel-2)" strokeWidth={sw} />
          <circle
            cx={mid}
            cy={mid}
            r={r}
            fill="none"
            stroke={ringColor(pct)}
            strokeWidth={sw}
            strokeLinecap="round"
            strokeDasharray={c}
            strokeDashoffset={c * (1 - filled)}
            className="aios-ring"
            style={{ transition: "stroke-dashoffset 0.9s cubic-bezier(0.16,1,0.3,1)" }}
          />
        </svg>
        <span
          className="absolute font-mono font-semibold text-[var(--color-text)]"
          style={{ fontSize: Math.max(10, Math.round(size * 0.27)) }}
        >
          {Math.round(pct)}
        </span>
      </div>
      <span className="font-mono text-[var(--color-muted)]" style={{ fontSize: size >= 60 ? 11 : 9 }}>
        {label}
        {resetsAt ? ` ${resetIn(resetsAt)}` : ""}
      </span>
    </div>
  );
}

/** Compact number formatter: 1234 → 1.2k, 3.4M. */
function fmtNum(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(n >= 10_000_000_000 ? 0 : 1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

/** Short label for a model id: "claude-sonnet-4-5-20250101" → "sonnet 4.5". */
function shortModel(model: string): string {
  return model
    .replace(/^claude-/, "")
    .replace(/-\d{6,}$/, "")
    .replace(/-(\d)-(\d)$/, " $1.$2")
    .replace(/-/g, " ");
}

/** Compact "since" date: an ISO/date string → "may '25". */
function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const mon = d.toLocaleDateString(undefined, { month: "short" }).toLowerCase();
  return `${mon} '${String(d.getFullYear()).slice(-2)}`;
}

/** Heatmap cell color ramp by relative count. */
function heatColor(count: number, max: number): string {
  if (count <= 0) return "var(--color-panel-2)";
  const t = max > 0 ? count / max : 0;
  if (t > 0.78) return "var(--color-highlight)";
  const pct = Math.round(35 + Math.min(t, 1) * 60);
  return `color-mix(in srgb, var(--color-accent) ${pct}%, transparent)`;
}

// Shared with PulsePane (the click-to-detail view) so the rich pane reuses the
// exact same ring + heatmap + formatting — no duplication.
export { Ring, heatColor, fmtNum, shortModel, shortDate };
