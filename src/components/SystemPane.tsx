/** SystemPane — THE SYSTEM (solo-leveling life dashboard), desktop edition.
 *
 * The watch shows the status window; this pane is the full guild hall:
 * level/rank/xp, the four stats with real numbers, money breakdown (actual
 * bank position from ~/finances/accounts.json via the watch listener),
 * daily quests, weight trend, and INPUTS — log today's weight, tune goals.
 *
 * Data: the aios watch listener on localhost:8768 (loopback = no token).
 *   GET  /system           → stat sheet
 *   GET  /system/history   → fitness log rows (weight trend)
 *   POST /fitness          → { date, weightKg } manual log (merge-upsert)
 *   POST /system/config    → { weightGoalKg, kcalTarget }
 */
import { useCallback, useEffect, useState } from "react";
import { Swords, RefreshCw, TrendingUp, Coins, HeartPulse, Zap, CheckSquare, Square } from "lucide-react";

const BASE = "http://127.0.0.1:8768";

type SystemState = {
  name: string; level: number; rank: string; xp: number;
  defense: { weight: number; weightGoal: number; hpPct: number; vitPct?: number; gymStreak: number; stepsToday: number; activeKcalToday: number; gymToday: boolean };
  offense: { monthlyIncomeMYR: number; monthlyFixedMYR: number; netMYR: number; cashMYR?: number; ccDebtMYR?: number; receivableMYR?: number; ships7d: number };
  quests: { name: string; done: boolean }[];
};

type HistoryRow = { date: string; weightKg?: number | null; steps?: number | null; workouts?: unknown[] };

export function SystemPane({ active }: { active?: boolean }) {
  const [sys, setSys] = useState<SystemState | null>(null);
  const [hist, setHist] = useState<HistoryRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [weightInput, setWeightInput] = useState("");
  const [goalInput, setGoalInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState("");

  const load = useCallback(async () => {
    try {
      setErr(null);
      const [s, h] = await Promise.all([
        fetch(`${BASE}/system`).then((r) => r.json()),
        fetch(`${BASE}/system/history`).then((r) => r.json()),
      ]);
      setSys(s);
      setHist(h.rows || []);
    } catch {
      setErr("system unreachable — is the watch listener running? (launchctl list | grep aios-watch)");
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    void load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [active, load]);

  const flash = (msg: string) => {
    setSavedFlash(msg);
    setTimeout(() => setSavedFlash(""), 2500);
  };

  const logWeight = async () => {
    const w = parseFloat(weightInput);
    if (!w || w < 30 || w > 200) return;
    setSaving(true);
    try {
      await fetch(`${BASE}/fitness`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ date: new Date().toISOString().slice(0, 10), weightKg: w }),
      });
      setWeightInput("");
      flash(`weight logged — ${w}kg`);
      void load();
    } finally {
      setSaving(false);
    }
  };

  const saveGoal = async () => {
    const g = parseFloat(goalInput);
    if (!g || g < 40 || g > 150) return;
    setSaving(true);
    try {
      await fetch(`${BASE}/system/config`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ weightGoalKg: g }),
      });
      setGoalInput("");
      flash(`max-hp goal → ${g}kg`);
      void load();
    } finally {
      setSaving(false);
    }
  };

  const weights = hist.filter((r) => r.weightKg != null).slice(-30);

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--color-pane)]">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--color-border)] px-3">
        <Swords size={14} className="text-[var(--color-accent)]" />
        <span className="text-[13px] font-medium text-[var(--color-text)]">the system</span>
        {sys && (
          <span className="text-[11px] text-[var(--color-muted)]">
            LV.{sys.level} · rank {sys.rank} · {sys.xp.toLocaleString()} xp
          </span>
        )}
        {savedFlash && <span className="text-[11px] text-[var(--color-success)]">{savedFlash}</span>}
        <button
          onClick={() => void load()}
          className="ml-auto rounded p-1 text-[var(--color-muted)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
          title="refresh"
        >
          <RefreshCw size={12} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {err && (
          <div className="mb-3 rounded-md border border-[var(--color-danger)]/35 bg-[var(--color-danger)]/10 px-3 py-2 text-[12px] text-[var(--color-danger)]">
            {err}
          </div>
        )}
        {sys && (
          <div className="flex flex-col gap-4">
            {/* hero: level + rank + xp */}
            <div className="rounded-md border border-[var(--color-accent)]/30 bg-[var(--color-bg)]/35 px-4 py-3">
              <div className="flex items-end justify-between">
                <div>
                  <div className="text-[9px] uppercase tracking-wide text-[var(--color-faint)]">hunter</div>
                  <div className="flex items-baseline gap-2">
                    <span className="font-mono text-[32px] font-bold text-[var(--color-text)]">LV.{sys.level}</span>
                    <span className="text-[13px] text-[var(--color-muted)]">{sys.name}</span>
                  </div>
                </div>
                <div className="flex h-12 w-12 items-center justify-center rounded-lg border border-[var(--color-accent)]/50 bg-[var(--color-accent)]/15 font-mono text-[22px] font-black text-[var(--color-accent)]">
                  {sys.rank}
                </div>
              </div>
              <Bar value={(sys.xp % 200) / 200} cls="bg-[var(--color-accent)]" />
              <div className="mt-1 text-[10px] text-[var(--color-faint)]">
                {sys.xp % 200}/200 xp to LV.{sys.level + 1}
              </div>
            </div>

            {/* stat grid */}
            <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
              <Stat icon={<HeartPulse size={12} />} label="HP · max grows with weight"
                    value={`${sys.defense.weight} / ${sys.defense.weightGoal}kg`}
                    bar={sys.defense.hpPct / 100} tint="var(--color-danger)" />
              <Stat icon={<Zap size={12} />} label="VIT · today's engine"
                    value={`${sys.defense.vitPct ?? 0}%`}
                    sub={`${sys.defense.stepsToday.toLocaleString()} steps · ${sys.defense.activeKcalToday}kcal${sys.defense.gymStreak ? ` · ${sys.defense.gymStreak}d streak` : ""}`}
                    bar={(sys.defense.vitPct ?? 0) / 100} tint="var(--color-success)" />
              <Stat icon={<TrendingUp size={12} />} label="ATK · ships 7d"
                    value={`${sys.offense.ships7d}`}
                    bar={Math.min(1, sys.offense.ships7d / 250)} tint="var(--color-accent)" />
              <Stat icon={<Coins size={12} />} label="GOLD · net liquid"
                    value={`RM${Math.round(sys.offense.netMYR).toLocaleString()}`}
                    sub={`RM${Math.round(sys.offense.cashMYR ?? 0).toLocaleString()} cash − RM${Math.round(sys.offense.ccDebtMYR ?? 0).toLocaleString()} cc`}
                    bar={Math.max(0, Math.min(1, (sys.offense.netMYR + 3000) / 8000))} tint="var(--color-highlight, #fbbf24)" />
            </div>

            <div className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
              <div className="flex flex-col gap-4">
                {/* quests */}
                <section>
                  <div className="mb-2 flex items-center gap-2 text-[10px] uppercase tracking-wide text-[var(--color-faint)]">
                    <CheckSquare size={11} className="text-[var(--color-accent)]" />
                    daily quests
                    <span className="ml-auto font-mono">{sys.quests.filter((q) => q.done).length}/{sys.quests.length}</span>
                  </div>
                  <div className="flex flex-col gap-1">
                    {sys.quests.map((q) => (
                      <div key={q.name}
                           className={`flex items-center gap-2 rounded-md border border-[var(--color-border)] px-2.5 py-1.5 text-[12px] ${q.done ? "bg-[var(--color-success)]/8 text-[var(--color-text)]" : "bg-[var(--color-bg)]/35 text-[var(--color-muted)]"}`}>
                        {q.done
                          ? <CheckSquare size={13} className="text-[var(--color-success)]" />
                          : <Square size={13} className="text-[var(--color-faint)]" />}
                        <span className={q.done ? "line-through opacity-70" : ""}>{q.name}</span>
                      </div>
                    ))}
                  </div>
                </section>

                {/* money detail */}
                <section>
                  <div className="mb-2 text-[10px] uppercase tracking-wide text-[var(--color-faint)]">treasury</div>
                  <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)]/35 px-3 py-2 text-[12px]">
                    <Row k="cash on hand" v={`RM${Math.round(sys.offense.cashMYR ?? 0).toLocaleString()}`} />
                    <Row k="credit card" v={`−RM${Math.round(sys.offense.ccDebtMYR ?? 0).toLocaleString()}`} danger />
                    <Row k="net liquid" v={`RM${Math.round(sys.offense.netMYR).toLocaleString()}`} strong danger={sys.offense.netMYR < 0} />
                    <div className="my-1 border-t border-[var(--color-border)]" />
                    <Row k="income / month" v={`RM${Math.round(sys.offense.monthlyIncomeMYR).toLocaleString()}`} />
                    {(sys.offense.receivableMYR ?? 0) > 0 && (
                      <Row k="⚔ receivable — invoice it" v={`RM${Math.round(sys.offense.receivableMYR!).toLocaleString()}`} accent />
                    )}
                  </div>
                </section>
              </div>

              <div className="flex flex-col gap-4">
                {/* weight trend */}
                <section>
                  <div className="mb-2 text-[10px] uppercase tracking-wide text-[var(--color-faint)]">max-hp trend (weight)</div>
                  <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)]/35 p-3">
                    {weights.length >= 2 ? (
                      <Sparkline points={weights.map((w) => w.weightKg as number)} goal={sys.defense.weightGoal} />
                    ) : (
                      <div className="py-4 text-center text-[11px] text-[var(--color-faint)]">
                        log weight a few days in a row and the trend appears
                      </div>
                    )}
                  </div>
                </section>

                {/* inputs */}
                <section>
                  <div className="mb-2 text-[10px] uppercase tracking-wide text-[var(--color-faint)]">log / tune</div>
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center gap-2">
                      <input
                        value={weightInput}
                        onChange={(e) => setWeightInput(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && void logWeight()}
                        placeholder="today's weight (kg)"
                        inputMode="decimal"
                        className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-[12px] text-[var(--color-text)] placeholder-[var(--color-faint)] outline-none focus:border-[var(--color-accent)]/60"
                      />
                      <button onClick={() => void logWeight()} disabled={saving}
                              className="shrink-0 rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-[12px] font-medium text-[var(--color-accent-fg)] hover:opacity-90 disabled:opacity-50">
                        log
                      </button>
                    </div>
                    <div className="flex items-center gap-2">
                      <input
                        value={goalInput}
                        onChange={(e) => setGoalInput(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && void saveGoal()}
                        placeholder={`max-hp goal (now ${sys.defense.weightGoal}kg)`}
                        inputMode="decimal"
                        className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-[12px] text-[var(--color-text)] placeholder-[var(--color-faint)] outline-none focus:border-[var(--color-accent)]/60"
                      />
                      <button onClick={() => void saveGoal()} disabled={saving}
                              className="shrink-0 rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-1.5 text-[12px] text-[var(--color-text)] hover:border-[var(--color-accent)]/50 disabled:opacity-50">
                        set goal
                      </button>
                    </div>
                  </div>
                </section>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Bar({ value, cls }: { value: number; cls?: string }) {
  return (
    <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-panel-2)]">
      <div className={`h-full rounded-full ${cls || "bg-[var(--color-accent)]"}`}
           style={{ width: `${Math.max(1, Math.min(100, value * 100))}%` }} />
    </div>
  );
}

function Stat({ icon, label, value, sub, bar, tint }: {
  icon: React.ReactNode; label: string; value: string; sub?: string; bar: number; tint: string;
}) {
  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)]/35 px-2.5 py-2">
      <div className="flex items-center gap-1.5 text-[9px] uppercase tracking-wide text-[var(--color-faint)]">
        <span style={{ color: tint }}>{icon}</span>
        {label}
      </div>
      <div className="mt-0.5 font-mono text-[18px] font-semibold text-[var(--color-text)]">{value}</div>
      {sub && <div className="text-[10px] text-[var(--color-muted)]">{sub}</div>}
      <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-panel-2)]">
        <div className="h-full rounded-full" style={{ width: `${Math.max(2, Math.min(100, bar * 100))}%`, background: tint }} />
      </div>
    </div>
  );
}

function Row({ k, v, strong, danger, accent }: { k: string; v: string; strong?: boolean; danger?: boolean; accent?: boolean }) {
  return (
    <div className="flex items-center justify-between py-0.5">
      <span className={`${accent ? "text-[var(--color-accent)]" : "text-[var(--color-muted)]"} text-[11px]`}>{k}</span>
      <span className={`font-mono text-[12px] ${strong ? "font-semibold" : ""} ${danger ? "text-[var(--color-danger)]" : accent ? "text-[var(--color-accent)]" : "text-[var(--color-text)]"}`}>{v}</span>
    </div>
  );
}

function Sparkline({ points, goal }: { points: number[]; goal: number }) {
  const w = 260, h = 64, pad = 4;
  const min = Math.min(...points, goal) - 1;
  const max = Math.max(...points, goal) + 1;
  const x = (i: number) => pad + (i / Math.max(1, points.length - 1)) * (w - pad * 2);
  const y = (v: number) => h - pad - ((v - min) / (max - min)) * (h - pad * 2);
  const d = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p).toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full">
      <line x1={pad} x2={w - pad} y1={y(goal)} y2={y(goal)}
            stroke="var(--color-success)" strokeDasharray="3 3" strokeWidth="1" opacity="0.5" />
      <path d={d} fill="none" stroke="var(--color-accent)" strokeWidth="2" strokeLinecap="round" />
      <circle cx={x(points.length - 1)} cy={y(points[points.length - 1])} r="3" fill="var(--color-accent)" />
      <text x={w - pad} y={y(goal) - 3} textAnchor="end" fontSize="8" fill="var(--color-success)" opacity="0.8">
        goal {goal}kg
      </text>
    </svg>
  );
}
