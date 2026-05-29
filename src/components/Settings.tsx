/** Glassmorphic settings window — native-feeling preferences modal for the
 *  AIOS cockpit. Left nav rail + scrollable right panel. Esc / backdrop close.
 *  Every control persists through src/lib/settings.ts. lowercase, terse. */
import {
  type ComponentType,
  type ReactNode,
  useEffect,
  useState,
} from "react";

import {
  Brain,
  Cpu,
  Info,
  Keyboard,
  Minus,
  Palette,
  Plus,
  Settings as SettingsIcon,
  X,
} from "lucide-react";

import {
  type AppSettings,
  type PaneType,
  loadSettings,
  saveSettings,
  MEMORY_VAULT_PATH,
} from "../lib/settings";

/* ── control primitives ─────────────────────────────────────────────── */

/** Label (+ optional sub-description) on the left, control on the right. */
function Row({
  label,
  sub,
  children,
}: {
  label: string;
  sub?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5">
      <div className="min-w-0">
        <div className="text-[13px] text-[var(--color-text)]">{label}</div>
        {sub && (
          <div className="mt-0.5 text-[11px] leading-snug text-[var(--color-muted)]">
            {sub}
          </div>
        )}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/** Pill switch — slides + goes accent when on. */
function Toggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="relative h-[22px] w-[38px] rounded-full border transition-colors"
      style={{
        background: checked ? "var(--color-accent)" : "var(--color-panel-2)",
        borderColor: checked
          ? "var(--color-accent)"
          : "var(--color-border-strong)",
      }}
    >
      <span
        className="absolute top-[2px] h-[16px] w-[16px] rounded-full bg-white shadow transition-all duration-200"
        style={{ left: checked ? "18px" : "2px" }}
      />
    </button>
  );
}

/** Number stepper with - / + and bounds. */
function Stepper({
  value,
  min,
  max,
  step = 1,
  suffix,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  onChange: (v: number) => void;
}) {
  const clamp = (n: number) => Math.min(max, Math.max(min, n));
  return (
    <div className="flex items-center gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)]/50 p-0.5">
      <button
        onClick={() => onChange(clamp(value - step))}
        disabled={value <= min}
        className="grid h-6 w-6 place-items-center rounded-md text-[var(--color-text-2)] hover:bg-[var(--color-pane)] disabled:opacity-30"
      >
        <Minus size={12} />
      </button>
      <span className="min-w-[42px] text-center font-mono text-[12px] tabular-nums text-[var(--color-text)]">
        {value}
        {suffix ? <span className="text-[var(--color-muted)]">{suffix}</span> : null}
      </span>
      <button
        onClick={() => onChange(clamp(value + step))}
        disabled={value >= max}
        className="grid h-6 w-6 place-items-center rounded-md text-[var(--color-text-2)] hover:bg-[var(--color-pane)] disabled:opacity-30"
      >
        <Plus size={12} />
      </button>
    </div>
  );
}

/** Range slider — accent fill, value readout. */
function Slider({
  value,
  min = 0,
  max = 100,
  onChange,
}: {
  value: number;
  min?: number;
  max?: number;
  onChange: (v: number) => void;
}) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div className="flex w-[180px] items-center gap-3">
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full outline-none [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow"
        style={{
          background: `linear-gradient(to right, var(--color-accent) ${pct}%, var(--color-panel-2) ${pct}%)`,
        }}
      />
      <span className="w-7 text-right font-mono text-[11px] tabular-nums text-[var(--color-muted)]">
        {value}
      </span>
    </div>
  );
}

/** Segmented control — one of N options, accent on selected. */
function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex gap-0.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)]/50 p-0.5">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            onClick={() => onChange(o.value)}
            className="rounded-md px-2.5 py-1 text-[12px] transition-colors"
            style={{
              background: active ? "var(--color-accent)" : "transparent",
              color: active ? "#fff" : "var(--color-text-2)",
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/* ── sections ───────────────────────────────────────────────────────── */

type SectionId =
  | "general"
  | "appearance"
  | "oracles"
  | "memory"
  | "shortcuts"
  | "about";

const NAV: { id: SectionId; label: string; icon: ComponentType<{ size?: number }> }[] = [
  { id: "general", label: "general", icon: SettingsIcon },
  { id: "appearance", label: "appearance", icon: Palette },
  { id: "oracles", label: "oracles", icon: Cpu },
  { id: "memory", label: "memory", icon: Brain },
  { id: "shortcuts", label: "shortcuts", icon: Keyboard },
  { id: "about", label: "about", icon: Info },
];

/** A keycap chip — font-mono, raised. */
function Keycap({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-grid min-w-[22px] place-items-center rounded-md border border-[var(--color-border-strong)] bg-[var(--color-panel-2)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--color-text)] shadow-sm">
      {children}
    </kbd>
  );
}

const SHORTCUTS: { keys: string[]; action: string }[] = [
  { keys: ["⌘", "B"], action: "toggle sidebar" },
  { keys: ["⌘", "K"], action: "command palette" },
  { keys: ["⌘", "⌘"], action: "appshot" },
  { keys: ["⌘", "T"], action: "new terminal" },
  { keys: ["⌘", "W"], action: "close pane" },
  { keys: ["⌘", ","], action: "open settings" },
];

/* ── main component ─────────────────────────────────────────────────── */

export function Settings({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [section, setSection] = useState<SectionId>("general");
  const [s, setS] = useState<AppSettings>(loadSettings);

  // re-sync from store each time the window opens.
  useEffect(() => {
    if (open) setS(loadSettings());
  }, [open]);

  // esc closes.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  /** Persist + update local state in one move. */
  const patch = (p: Partial<AppSettings>) => setS(saveSettings(p));

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/45 p-6 backdrop-blur-sm"
      onMouseDown={onClose}
    >
      <div
        className="modal-in glass flex h-[520px] w-[720px] max-w-full overflow-hidden rounded-2xl border border-[var(--color-border-strong)] bg-[var(--color-panel)]/90 shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* nav rail */}
        <nav className="flex w-[180px] shrink-0 flex-col gap-0.5 border-r border-[var(--color-border)] bg-[var(--color-bg)]/40 p-2">
          <div className="flex items-center gap-2 px-2 py-2.5">
            <img src="/mascot.png" alt="" className="h-5 w-5 rounded-full object-cover" />
            <span className="text-[12px] font-medium text-[var(--color-text)]">settings</span>
          </div>
          {NAV.map(({ id, label, icon: Icon }) => {
            const active = id === section;
            return (
              <button
                key={id}
                onClick={() => setSection(id)}
                className="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] transition-colors"
                style={{
                  background: active ? "var(--color-accent-soft)" : "transparent",
                  color: active ? "var(--color-accent)" : "var(--color-text-2)",
                }}
              >
                <Icon size={14} />
                {label}
              </button>
            );
          })}
        </nav>

        {/* content */}
        <div className="relative flex min-w-0 flex-1 flex-col">
          <button
            onClick={onClose}
            className="absolute right-3 top-3 z-10 grid h-7 w-7 place-items-center rounded-lg text-[var(--color-muted)] transition-colors hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
            aria-label="close"
          >
            <X size={15} />
          </button>

          <div className="flex-1 overflow-y-auto px-6 py-5">
            <h2 className="mb-3 text-[15px] font-medium lowercase text-[var(--color-text)]">
              {section}
            </h2>
            <div className="divide-y divide-[var(--color-border)]">
              {section === "general" && (
                <>
                  <Row
                    label="reopen last layout"
                    sub="restore your panes + sizes on startup"
                  >
                    <Toggle
                      checked={s.reopenLastLayout}
                      onChange={(v) => patch({ reopenLastLayout: v })}
                    />
                  </Row>
                  <Row
                    label="confirm before closing oracle pane"
                    sub="ask before killing a live oracle session"
                  >
                    <Toggle
                      checked={s.confirmCloseOraclePane}
                      onChange={(v) => patch({ confirmCloseOraclePane: v })}
                    />
                  </Row>
                  <Row label="default new-pane type">
                    <Segmented<PaneType>
                      value={s.defaultPaneType}
                      onChange={(v) => patch({ defaultPaneType: v })}
                      options={[
                        { value: "terminal", label: "terminal" },
                        { value: "files", label: "files" },
                        { value: "browser", label: "browser" },
                      ]}
                    />
                  </Row>
                </>
              )}

              {section === "appearance" && (
                <>
                  <Row label="accent intensity" sub="how loud the orange runs">
                    <Slider
                      value={s.accentIntensity}
                      onChange={(v) => patch({ accentIntensity: v })}
                    />
                  </Row>
                  <Row label="terminal font size">
                    <Stepper
                      value={s.terminalFontSize}
                      min={10}
                      max={18}
                      suffix="px"
                      onChange={(v) => patch({ terminalFontSize: v })}
                    />
                  </Row>
                  <Row label="splash on launch" sub="show the mascot boot screen">
                    <Toggle
                      checked={s.splashOnLaunch}
                      onChange={(v) => patch({ splashOnLaunch: v })}
                    />
                  </Row>
                  <Row label="reduce motion" sub="cut animations + transitions">
                    <Toggle
                      checked={s.reduceMotion}
                      onChange={(v) => patch({ reduceMotion: v })}
                    />
                  </Row>
                </>
              )}

              {section === "oracles" && (
                <>
                  <Row label="default socket name" sub="tmux socket oracles bind to">
                    <input
                      value={s.defaultSocketName}
                      onChange={(e) => patch({ defaultSocketName: e.target.value })}
                      spellCheck={false}
                      className="w-[160px] rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)]/50 px-2.5 py-1 font-mono text-[12px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
                    />
                  </Row>
                  <Row label="auto-refresh interval">
                    <Stepper
                      value={s.autoRefreshSeconds}
                      min={5}
                      max={120}
                      step={5}
                      suffix="s"
                      onChange={(v) => patch({ autoRefreshSeconds: v })}
                    />
                  </Row>
                  <Row
                    label="show non-aios tmux sessions"
                    sub="include sessions not started by aios"
                  >
                    <Toggle
                      checked={s.showNonAiosSessions}
                      onChange={(v) => patch({ showNonAiosSessions: v })}
                    />
                  </Row>
                </>
              )}

              {section === "memory" && (
                <>
                  <Row label="vault path" sub="read-only — where memories live">
                    <code className="block max-w-[260px] truncate rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)]/50 px-2.5 py-1 font-mono text-[11px] text-[var(--color-muted)]">
                      {MEMORY_VAULT_PATH}
                    </code>
                  </Row>
                  <Row
                    label="graph physics strength"
                    sub="how hard the memory graph pulls together"
                  >
                    <Slider
                      value={s.graphPhysicsStrength}
                      onChange={(v) => patch({ graphPhysicsStrength: v })}
                    />
                  </Row>
                </>
              )}

              {section === "shortcuts" && (
                <div className="-mt-1">
                  {SHORTCUTS.map((sc) => (
                    <div
                      key={sc.action}
                      className="flex items-center justify-between border-b border-[var(--color-border)] py-2.5 last:border-0"
                    >
                      <span className="text-[13px] text-[var(--color-text-2)]">
                        {sc.action}
                      </span>
                      <span className="flex items-center gap-1">
                        {sc.keys.map((k, i) => (
                          <Keycap key={i}>{k}</Keycap>
                        ))}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {section === "about" && (
                <div className="flex flex-col items-center gap-3 py-8 text-center">
                  <img
                    src="/mascot.png"
                    alt="aios"
                    className="h-20 w-20 rounded-2xl object-cover shadow-lg"
                  />
                  <div>
                    <div className="text-[16px] font-medium text-[var(--color-text)]">
                      AIOS cockpit
                    </div>
                    <div className="mt-0.5 font-mono text-[11px] text-[var(--color-muted)]">
                      v0.1.0
                    </div>
                  </div>
                  <p className="text-[12px] text-[var(--color-text-2)]">
                    your AI co-founder&apos;s command deck
                  </p>
                  <div className="mt-1 flex gap-2">
                    <button className="rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)]/50 px-3 py-1.5 text-[12px] text-[var(--color-text-2)] transition-colors hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)]">
                      github
                    </button>
                    <button className="rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)]/50 px-3 py-1.5 text-[12px] text-[var(--color-text-2)] transition-colors hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)]">
                      docs
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
