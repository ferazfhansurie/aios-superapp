/** Bottom-left glassmorphic account + usage menu (Codex-style).
 *  Usage is REAL: the AIOS statusline hook writes ~/.aios/state/usage.json on
 *  every claude tick (the only source of the 5h/7d rate-limit %). Read via the
 *  `usage_stats` Rust command. No more hardcoded bars. */
import { useCallback, useEffect, useRef, useState } from "react";

import { invoke } from "@tauri-apps/api/core";
import { Activity, ChevronUp, Flame, LogOut, Settings as SettingsIcon } from "lucide-react";

import { usageExtras, type UsageExtras } from "../lib/stats";

interface Window {
  used_percentage: number | null;
  resets_at: number | null;
}
interface Usage {
  ts: number;
  model: string;
  rate_limits: { five_hour: Window; seven_day: Window };
  cost: { total_cost_usd: number | null };
  context_window: { used_percentage: number | null };
}

/** "58m" / "6d 22h" / "now" from a unix-seconds reset timestamp. */
function resetIn(ts: number | null): string {
  if (!ts) return "";
  const rem = ts - Math.floor(Date.now() / 1000);
  if (rem <= 0) return "now";
  const h = Math.floor(rem / 3600);
  const m = Math.floor((rem % 3600) / 60);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

/** Bar color escalates as a window fills — green → amber → orange → red. */
function barColor(pct: number): string {
  if (pct >= 90) return "var(--color-danger)";
  if (pct >= 70) return "var(--color-warning)";
  return "var(--color-accent)";
}

/** Heatmap square fill — quantize a day's count to 5 buckets scaling the accent
 *  (orange) up toward warning (yellow). 0 = the faint panel-2 base. */
function heatColor(count: number, max: number): string {
  if (count <= 0) return "var(--color-panel-2)";
  const t = max > 0 ? count / max : 0;
  if (t > 0.75) return "var(--color-warning)"; // brightest = yellow
  const opacity = 0.35 + Math.min(t, 1) * 0.6; // 0.35 → 0.95 accent
  return `color-mix(in srgb, var(--color-accent) ${Math.round(opacity * 100)}%, transparent)`;
}

/** Compact integer formatting for big token/message numbers: 12.3k, 1.2M. */
function compact(n: number | null): string {
  if (n == null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

export function AccountMenu({ onOpenSettings }: { onOpenSettings?: () => void }) {
  const [open, setOpen] = useState(false);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [extras, setExtras] = useState<UsageExtras | null>(null);
  const [, force] = useState(0); // re-render so countdowns tick
  const ref = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  // Fixed-position anchor so the popup escapes the sidebar panel's overflow
  // clipping (was getting cut off / overlapped by the terminal pane).
  const [pos, setPos] = useState<{ left: number; bottom: number }>({ left: 8, bottom: 56 });
  useEffect(() => {
    if (!open) return;
    const b = btnRef.current?.getBoundingClientRect();
    if (b) setPos({ left: b.left, bottom: window.innerHeight - b.top + 8 });
  }, [open]);

  const refresh = useCallback(async () => {
    try {
      setUsage(await invoke<Usage | null>("usage_stats"));
    } catch {
      setUsage(null);
    }
  }, []);

  // Long-horizon stats (heatmap/streaks/totals) — fetched on open + every 60s.
  const refreshExtras = useCallback(async () => {
    try {
      setExtras(await usageExtras());
    } catch {
      setExtras(null);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    refreshExtras();
    const t = setInterval(refreshExtras, 60_000);
    return () => clearInterval(t);
  }, [open, refreshExtras]);

  // poll the shared file + tick the countdown every 30s (and on open).
  useEffect(() => {
    refresh();
    const t = setInterval(() => {
      refresh();
      force((n) => n + 1);
    }, 30_000);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    if (open) refresh();
  }, [open, refresh]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [open]);

  const fh = usage?.rate_limits?.five_hour;
  const sd = usage?.rate_limits?.seven_day;
  const bars = [
    { label: "5h limit", w: fh },
    { label: "7d limit", w: sd },
  ].filter((b) => b.w?.used_percentage != null) as {
    label: string;
    w: Window;
  }[];

  return (
    <div ref={ref} className="relative">
      {open && (
        <div
          style={{ left: pos.left, bottom: pos.bottom }}
          className="modal-in glass fixed z-[60] w-80 overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)]/90 p-1.5 shadow-2xl"
        >
          <div className="flex items-center gap-2 px-2 py-2">
            <img src="/mascot.png" alt="" className="h-6 w-6 rounded-full object-cover" />
            <div className="min-w-0">
              <div className="truncate text-[12px] text-[var(--color-text)]">firaz · adletic</div>
              <div className="truncate text-[10px] text-[var(--color-muted)]">owner</div>
            </div>
          </div>
          <div className="my-1 h-px bg-[var(--color-border)]" />
          <button
            onClick={() => {
              setOpen(false);
              onOpenSettings?.();
            }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-[var(--color-text-2)] hover:bg-[var(--color-panel-2)]"
          >
            <SettingsIcon size={13} /> settings
          </button>

          <div className="my-1 h-px bg-[var(--color-border)]" />
          <div className="flex items-center justify-between px-2 py-1">
            <span className="text-[9px] font-medium uppercase tracking-widest text-[var(--color-muted)]">
              usage
            </span>
            {usage?.model && (
              <span className="truncate text-[9px] text-[var(--color-faint)]">{usage.model}</span>
            )}
          </div>

          {bars.length === 0 ? (
            <div className="px-2 py-2 text-[10px] leading-relaxed text-[var(--color-muted)]">
              waiting for first statusline tick — open any oracle, then it shows your live 5h / 7d
              limits.
            </div>
          ) : (
            bars.map(({ label, w }) => {
              const pct = Math.round(w.used_percentage ?? 0);
              return (
                <div key={label} className="px-2 py-1">
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-[var(--color-text-2)]">{label}</span>
                    <span className="text-[var(--color-muted)]">
                      {pct}%{w.resets_at ? ` · resets ${resetIn(w.resets_at)}` : ""}
                    </span>
                  </div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-[var(--color-panel-2)]">
                    <div
                      className="h-full rounded-full transition-all duration-500"
                      style={{ width: `${pct}%`, background: barColor(pct) }}
                    />
                  </div>
                </div>
              );
            })
          )}

          {(usage?.cost?.total_cost_usd != null ||
            usage?.context_window?.used_percentage != null) && (
            <div className="flex items-center justify-between px-2 pb-1 pt-1.5 text-[10px] text-[var(--color-faint)]">
              {usage?.context_window?.used_percentage != null && (
                <span>ctx {usage.context_window.used_percentage}%</span>
              )}
              {usage?.cost?.total_cost_usd != null && (
                <span>session ${usage.cost.total_cost_usd.toFixed(2)}</span>
              )}
            </div>
          )}

          {extras && extras.heatmap.length > 0 && (
            <>
              <div className="my-1 h-px bg-[var(--color-border)]" />
              {(() => {
                const max = extras.heatmap.reduce((m, d) => Math.max(m, d.count), 0);
                // Last 70 days, ascending → 10 cols (weeks) × 7 rows (days).
                // CSS grid flows column-major so each column is one week.
                return (
                  <div className="px-2 py-1">
                    <div className="mb-1.5 flex items-center gap-1 text-[9px] font-medium uppercase tracking-widest text-[var(--color-muted)]">
                      <Activity size={10} /> activity · 10 weeks
                    </div>
                    <div
                      className="grid w-fit gap-[2px]"
                      style={{ gridTemplateRows: "repeat(7, 9px)", gridAutoFlow: "column" }}
                    >
                      {extras.heatmap.map((d) => (
                        <div
                          key={d.date}
                          title={`${d.date} · ${d.count}`}
                          className="h-[9px] w-[9px] rounded-[2px]"
                          style={{ background: heatColor(d.count, max) }}
                        />
                      ))}
                    </div>
                  </div>
                );
              })()}

              <div className="flex items-center gap-1.5 px-2 py-1 text-[10px] text-[var(--color-text-2)]">
                <Flame size={11} className="text-[var(--color-accent)]" />
                <span>
                  current <span className="font-mono">{extras.currentStreak}</span>d
                </span>
                <span className="text-[var(--color-faint)]">·</span>
                <span>
                  longest <span className="font-mono">{extras.longestStreak}</span>d
                </span>
                <span className="text-[var(--color-faint)]">·</span>
                <span>
                  active <span className="font-mono">{extras.active7d}</span>/7
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-x-1 px-2 pb-1 text-[10px] text-[var(--color-faint)]">
                {extras.totalSessions != null && (
                  <span>
                    <span className="font-mono">{compact(extras.totalSessions)}</span> sessions
                  </span>
                )}
                {extras.totalMessages != null && (
                  <>
                    <span>·</span>
                    <span>
                      <span className="font-mono">{compact(extras.totalMessages)}</span> msgs
                    </span>
                  </>
                )}
                {extras.favoriteModel && (
                  <>
                    <span>·</span>
                    <span>{extras.favoriteModel}</span>
                  </>
                )}
                {extras.tokensTotal != null && (
                  <>
                    <span>·</span>
                    <span>
                      <span className="font-mono">{compact(extras.tokensTotal)}</span> tok
                    </span>
                  </>
                )}
              </div>
            </>
          )}

          <div className="my-1 h-px bg-[var(--color-border)]" />
          <button className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-[var(--color-muted)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]">
            <LogOut size={13} /> log out
          </button>
        </div>
      )}

      <button
        ref={btnRef}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)]/40 px-2 py-1.5 text-left transition-colors hover:border-[var(--color-border-strong)]"
      >
        <img src="/mascot.png" alt="" className="h-6 w-6 rounded-full object-cover" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12px] text-[var(--color-text)]">firaz</div>
          <div className="truncate text-[10px] text-[var(--color-muted)]">
            {fh?.used_percentage != null ? `5h ${Math.round(fh.used_percentage)}%` : "adletic · owner"}
          </div>
        </div>
        <ChevronUp size={14} className="text-[var(--color-muted)]" />
      </button>
    </div>
  );
}
