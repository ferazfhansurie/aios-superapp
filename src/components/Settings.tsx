/** Glassmorphic settings window — native-feeling preferences modal for the
 *  AIOS cockpit. Left nav rail + scrollable right panel. Esc / backdrop close.
 *  Every control persists through src/lib/settings.ts. lowercase, terse. */
import {
  type ComponentType,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  Blocks,
  Brain,
  Check,
  Cpu,
  Info,
  Keyboard,
  Minus,
  Eye,
  EyeOff,
  Monitor,
  Moon,
  PanelLeft,
  Palette,
  Plus,
  Radio,
  RotateCcw,
  Trash2,
  Settings as SettingsIcon,
  Sun,
  Type,
  X,
} from "lucide-react";

import { BridgesPane } from "./BridgesPane";
import { PluginsPane } from "./PluginsPane";

import {
  type AppSettings,
  type PaneType,
  loadSettings,
  saveSettings,
  MEMORY_VAULT_PATH,
} from "../lib/settings";

import {
  type SidebarState,
  loadSidebar,
  toggleHidden,
  removeItem,
  resetSidebar,
  subscribe as subscribeSidebar,
} from "../lib/sidebar";
import { SPAWN_BY_ID } from "../lib/apps";

import {
  type Accent,
  type Theme,
  ACCENT_PRESETS,
  ACCENT_ORDER,
  accentToHex,
  getAccent,
  getAccentRecents,
  getTheme,
  isCustomAccent,
  normalizeHex,
  setAccent,
  setTheme,
  subscribe as subscribeTheme,
  subscribeAccent,
} from "../lib/theme";

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
              color: active ? "var(--color-accent-fg)" : "var(--color-text-2)",
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/* ── appearance helpers ─────────────────────────────────────────────── */

/** density preset. comfortable = current spacing; compact tightens. */
type Density = "compact" | "comfortable";
const DENSITY_KEY = "aios.density";

function getDensity(): Density {
  try {
    const v = localStorage.getItem(DENSITY_KEY);
    if (v === "compact" || v === "comfortable") return v;
  } catch {
    /* ignore */
  }
  return "comfortable";
}

/**
 * Persist density + reflect it as data-density on :root so App.css can
 * respond. (App.css wiring is a follow-up — attr is set today.)
 */
function applyDensity(d: Density) {
  try {
    localStorage.setItem(DENSITY_KEY, d);
  } catch {
    /* ignore */
  }
  if (typeof document !== "undefined") {
    document.documentElement.dataset.density = d;
  }
}

/**
 * Map a terminal/chat font size (px) onto a root --app-font-scale multiplier,
 * baselined at 13px (the value TerminalPane hardcodes today). Chat/UI surfaces
 * can read var(--app-font-scale) to scale with this control.
 * NOTE: TerminalPane currently reads a hardcoded 13 — wiring it to read this
 * scale (or settings.terminalFontSize) is a follow-up.
 */
const FONT_BASELINE = 13;
function applyFontScale(px: number) {
  if (typeof document === "undefined") return;
  document.documentElement.style.setProperty(
    "--app-font-scale",
    String(px / FONT_BASELINE),
  );
}

/** Reflect reduce-motion as data-reduce-motion on :root for App.css to honor.
 *  (App.css wiring is a follow-up — attr is set today.) */
function applyReduceMotion(on: boolean) {
  if (typeof document === "undefined") return;
  if (on) document.documentElement.dataset.reduceMotion = "true";
  else delete document.documentElement.dataset.reduceMotion;
}

/** Codex-style theme picker — segmented, icon + label, with a preview hint
 *  swatch under each option. Wired through theme.ts so it stays in sync with
 *  the header ThemeSwitcher. */
function ThemePicker({
  value,
  onChange,
}: {
  value: Theme;
  onChange: (t: Theme) => void;
}) {
  const opts: {
    value: Theme;
    label: string;
    Icon: ComponentType<{ size?: number }>;
    /* mini preview: window bg + bar */
    bg: string;
    bar: string;
  }[] = [
    { value: "system", label: "system", Icon: Monitor, bg: "linear-gradient(120deg, #1a1c1f 0 50%, #f5f5f4 50% 100%)", bar: "var(--color-accent)" },
    { value: "light", label: "light", Icon: Sun, bg: "#f5f5f4", bar: "var(--color-accent)" },
    { value: "dark", label: "dark", Icon: Moon, bg: "#1a1c1f", bar: "var(--color-accent)" },
  ];
  return (
    <div className="grid grid-cols-3 gap-2">
      {opts.map(({ value: v, label, Icon, bg, bar }) => {
        const active = v === value;
        return (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(v)}
            className="group flex flex-col items-stretch gap-2 rounded-xl border p-2 text-left transition-all"
            style={{
              borderColor: active
                ? "var(--color-accent)"
                : "var(--color-border)",
              background: active
                ? "var(--color-accent-soft)"
                : "var(--color-panel-2)",
              boxShadow: active ? "0 0 0 1px var(--color-accent)" : "none",
            }}
          >
            {/* mini window preview */}
            <div
              className="relative h-10 w-full overflow-hidden rounded-lg border"
              style={{ background: bg, borderColor: "var(--color-border)" }}
            >
              <span
                className="absolute left-1.5 top-1.5 h-1 w-6 rounded-full"
                style={{ background: bar }}
              />
              <span
                className="absolute left-1.5 top-3.5 h-1 w-9 rounded-full opacity-50"
                style={{ background: "#888" }}
              />
            </div>
            <span
              className="flex items-center gap-1.5 text-[12px]"
              style={{
                color: active ? "var(--color-accent)" : "var(--color-text-2)",
              }}
            >
              <Icon size={13} />
              {label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** A single round accent dot. Active = ringed + check. */
function AccentDot({
  hex,
  active,
  label,
  onClick,
}: {
  hex: string;
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={label}
      onClick={onClick}
      className="relative grid h-7 w-7 place-items-center rounded-full transition-transform hover:scale-110"
      style={{
        background: hex,
        boxShadow: active
          ? "0 0 0 2px var(--color-panel), 0 0 0 4px var(--color-text)"
          : "0 0 0 1px rgba(0,0,0,0.25) inset",
      }}
    >
      {active && <Check size={14} strokeWidth={3} color="#fff" />}
    </button>
  );
}

/** Accent swatch row — 6 presets + recent customs + a "custom" picker.
 *  Click any swatch (or pick/type a hex) to re-tint the whole app live. */
function AccentSwatches({
  value,
  onChange,
}: {
  value: Accent;
  onChange: (a: Accent) => void;
}) {
  const colorInputRef = useRef<HTMLInputElement>(null);
  const custom = isCustomAccent(value);
  // current base hex (preset or custom) — drives the picker + hex field.
  const currentHex = accentToHex(value);
  const [hexDraft, setHexDraft] = useState(currentHex);
  const [recents, setRecents] = useState<string[]>(getAccentRecents);

  // keep the draft + recents in sync when the accent changes elsewhere.
  useEffect(() => {
    setHexDraft(currentHex);
    setRecents(getAccentRecents());
  }, [currentHex]);

  const commitHex = (raw: string) => {
    const norm = normalizeHex(raw);
    if (norm) onChange(norm);
  };

  return (
    <div className="flex flex-col items-end gap-2.5">
      <div className="flex items-center gap-2.5">
        {ACCENT_ORDER.map((a) => (
          <AccentDot
            key={a}
            hex={ACCENT_PRESETS[a]}
            active={value === a}
            label={a}
            onClick={() => onChange(a)}
          />
        ))}

        {/* recent custom colors */}
        {recents.map((hex) => (
          <AccentDot
            key={hex}
            hex={hex}
            active={custom && currentHex === hex}
            label={hex}
            onClick={() => onChange(hex)}
          />
        ))}

        {/* custom — rainbow + opens native color picker */}
        <button
          type="button"
          aria-label="custom color"
          title="custom color"
          aria-pressed={custom}
          onClick={() => colorInputRef.current?.click()}
          className="relative grid h-7 w-7 place-items-center rounded-full transition-transform hover:scale-110"
          style={{
            background:
              "conic-gradient(from 0deg, #ff5f57, #febc2e, #28c840, #339cff, #924ff7, #fb5b86, #ff5f57)",
            boxShadow: custom
              ? "0 0 0 2px var(--color-panel), 0 0 0 4px var(--color-text)"
              : "0 0 0 1px rgba(0,0,0,0.25) inset",
          }}
        >
          <Plus size={13} strokeWidth={3} color="#fff" />
          {/* the actual color input lives here, visually hidden but anchored
              under the swatch so the OS picker pops near it. */}
          <input
            ref={colorInputRef}
            type="color"
            value={currentHex}
            onChange={(e) => onChange(e.target.value)}
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
            aria-hidden
            tabIndex={-1}
          />
        </button>
      </div>

      {/* editable hex field — type or paste any color. */}
      <div className="flex items-center gap-2">
        <span
          className="h-4 w-4 shrink-0 rounded-[5px]"
          style={{
            background: currentHex,
            boxShadow: "0 0 0 1px rgba(0,0,0,0.25) inset",
          }}
        />
        <span className="font-mono text-[12px] text-[var(--color-muted)]">#</span>
        <input
          value={hexDraft.replace(/^#/, "")}
          onChange={(e) => setHexDraft(e.target.value)}
          onBlur={() => {
            commitHex(hexDraft);
            setHexDraft(currentHex);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              commitHex(hexDraft);
              (e.target as HTMLInputElement).blur();
            }
          }}
          spellCheck={false}
          maxLength={6}
          placeholder="f26522"
          className="w-[72px] rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)]/50 px-2 py-1 font-mono text-[12px] uppercase tracking-wide text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
        />
      </div>
    </div>
  );
}

/** A live preview card — shows current theme + accent + font scale at a glance.
 *  This is the "thing firaz called out" — instant feedback on every change. */
function AppearancePreview({ fontPx }: { fontPx: number }) {
  return (
    <div
      className="overflow-hidden rounded-xl border"
      style={{ borderColor: "var(--color-border)" }}
    >
      {/* faux titlebar */}
      <div
        className="flex items-center gap-1.5 border-b px-3 py-2"
        style={{
          borderColor: "var(--color-border)",
          background: "var(--color-bg)",
        }}
      >
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: "#ff5f57" }} />
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: "#febc2e" }} />
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: "#28c840" }} />
        <span className="ml-2 text-[10px] text-[var(--color-muted)]">preview</span>
      </div>
      {/* faux content */}
      <div className="flex gap-3 p-3" style={{ background: "var(--color-panel)" }}>
        <div className="flex flex-col gap-1.5">
          <span
            className="rounded-md px-2 py-1 text-[11px]"
            style={{ background: "var(--color-accent-soft)", color: "var(--color-accent)" }}
          >
            oracle
          </span>
          <span className="px-2 text-[11px] text-[var(--color-muted)]">files</span>
          <span className="px-2 text-[11px] text-[var(--color-muted)]">memory</span>
        </div>
        <div
          className="flex-1 rounded-lg border p-2.5"
          style={{
            borderColor: "var(--color-border)",
            background: "var(--color-bg)",
          }}
        >
          <p
            className="font-mono leading-relaxed text-[var(--color-text)]"
            style={{ fontSize: fontPx }}
          >
            <span style={{ color: "var(--color-accent)" }}>aios</span>
            <span className="text-[var(--color-muted)]"> ❯ </span>
            ship it.
            <span
              className="ml-0.5 inline-block h-[1em] w-[2px] translate-y-[2px]"
              style={{ background: "var(--color-cursor)" }}
            />
          </p>
          <p
            className="mt-1.5 leading-relaxed text-[var(--color-text-2)]"
            style={{ fontSize: fontPx }}
          >
            <span style={{ background: "var(--color-selection)" }}>
              selected text
            </span>{" "}
            looks like this.
          </p>
          <button
            className="mt-2.5 rounded-md px-2.5 py-1 text-[11px] font-medium"
            style={{
              background: "var(--color-accent)",
              color: "var(--color-accent-fg)",
            }}
          >
            primary action
          </button>
        </div>
      </div>
    </div>
  );
}

/** A small section sub-heading inside a pane. */
function GroupLabel({ children }: { children: ReactNode }) {
  return (
    <div className="pb-1.5 pt-1 text-[11px] font-medium uppercase tracking-wide text-[var(--color-muted)]">
      {children}
    </div>
  );
}

/* ── sections ───────────────────────────────────────────────────────── */

type SectionId =
  | "general"
  | "appearance"
  | "sidebar"
  | "oracles"
  | "channels"
  | "plugins"
  | "memory"
  | "shortcuts"
  | "about";

const NAV: { id: SectionId; label: string; icon: ComponentType<{ size?: number }> }[] = [
  { id: "general", label: "general", icon: SettingsIcon },
  { id: "appearance", label: "appearance", icon: Palette },
  { id: "sidebar", label: "sidebar", icon: PanelLeft },
  { id: "oracles", label: "oracles", icon: Cpu },
  { id: "channels", label: "channels", icon: Radio },
  { id: "plugins", label: "plugins", icon: Blocks },
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
  const [sidebar, setSidebar] = useState<SidebarState>(loadSidebar);
  useEffect(() => subscribeSidebar(setSidebar), []);
  const [theme, setLocalTheme] = useState<Theme>(getTheme);
  const [accent, setLocalAccent] = useState<Accent>(getAccent);
  const [density, setLocalDensity] = useState<Density>(getDensity);

  // re-sync from store each time the window opens.
  useEffect(() => {
    if (open) {
      setS(loadSettings());
      setLocalTheme(getTheme());
      setLocalAccent(getAccent());
      setLocalDensity(getDensity());
    }
  }, [open]);

  // reflect theme/accent changes from anywhere (e.g. the header switcher).
  useEffect(() => {
    const offT = subscribeTheme(setLocalTheme);
    const offA = subscribeAccent(setLocalAccent);
    return () => {
      offT();
      offA();
    };
  }, []);

  // apply persisted appearance attrs once so the cockpit reflects stored
  // prefs without requiring a toggle. (theme + accent are applied by
  // initTheme() in App.tsx — these are the display-only follow-up attrs.)
  useEffect(() => {
    const init = loadSettings();
    applyFontScale(init.terminalFontSize);
    applyReduceMotion(init.reduceMotion);
    applyDensity(getDensity());
  }, []);

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

          {section === "channels" || section === "plugins" ? (
            // Channels + plugins are full panes (own header + scroll) — render
            // them full-bleed instead of inside the padded settings rows.
            <div className="min-h-0 flex-1">
              {section === "channels" ? <BridgesPane /> : <PluginsPane />}
            </div>
          ) : (
          <div className="flex-1 overflow-y-auto px-6 py-5">
            <h2 className="mb-3 text-[15px] font-medium lowercase text-[var(--color-text)]">
              {section}
            </h2>
            <div className="divide-y divide-[var(--color-border)]">
              {section === "general" && (
                <>
                  <Row
                    label="your name"
                    sub="shown in the homescreen greeting + account row"
                  >
                    <input
                      value={s.userName}
                      onChange={(e) => patch({ userName: e.target.value })}
                      placeholder="your name"
                      spellCheck={false}
                      className="w-[160px] rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)]/50 px-2.5 py-1 text-[12px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
                    />
                  </Row>
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
                <div className="-mt-1 divide-y divide-[var(--color-border)]">
                  {/* theme */}
                  <div className="py-3">
                    <div className="mb-2">
                      <div className="text-[13px] text-[var(--color-text)]">theme</div>
                      <div className="mt-0.5 text-[11px] leading-snug text-[var(--color-muted)]">
                        use light, dark, or match your system
                      </div>
                    </div>
                    <ThemePicker
                      value={theme}
                      onChange={(t) => {
                        setTheme(t);
                        setLocalTheme(t);
                      }}
                    />
                  </div>

                  {/* accent */}
                  <div className="py-3">
                    <Row
                      label="accent"
                      sub="pick a preset or any custom color — re-tints the whole cockpit instantly"
                    >
                      <AccentSwatches
                        value={accent}
                        onChange={(a) => {
                          setAccent(a);
                          setLocalAccent(a);
                        }}
                      />
                    </Row>
                  </div>

                  {/* live preview */}
                  <div className="py-3">
                    <GroupLabel>preview</GroupLabel>
                    <AppearancePreview fontPx={s.terminalFontSize} />
                  </div>

                  {/* text size */}
                  <div className="py-1">
                    <Row
                      label="text size"
                      sub="base size for terminal + chat — scales the cockpit"
                    >
                      <div className="flex items-center gap-3">
                        <Type size={13} className="text-[var(--color-muted)]" />
                        <Slider
                          value={s.terminalFontSize}
                          min={10}
                          max={20}
                          onChange={(v) => {
                            patch({ terminalFontSize: v });
                            applyFontScale(v);
                          }}
                        />
                        <Stepper
                          value={s.terminalFontSize}
                          min={10}
                          max={20}
                          suffix="px"
                          onChange={(v) => {
                            patch({ terminalFontSize: v });
                            applyFontScale(v);
                          }}
                        />
                      </div>
                    </Row>
                  </div>

                  {/* density */}
                  <Row label="density" sub="how tight the cockpit packs">
                    <Segmented<Density>
                      value={density}
                      onChange={(d) => {
                        applyDensity(d);
                        setLocalDensity(d);
                      }}
                      options={[
                        { value: "comfortable", label: "comfortable" },
                        { value: "compact", label: "compact" },
                      ]}
                    />
                  </Row>

                  {/* toggles */}
                  <Row label="splash on launch" sub="show the mascot boot screen">
                    <Toggle
                      checked={s.splashOnLaunch}
                      onChange={(v) => patch({ splashOnLaunch: v })}
                    />
                  </Row>
                  <Row label="reduce motion" sub="cut animations + transitions">
                    <Toggle
                      checked={s.reduceMotion}
                      onChange={(v) => {
                        patch({ reduceMotion: v });
                        applyReduceMotion(v);
                      }}
                    />
                  </Row>
                </div>
              )}

              {section === "sidebar" && (
                <div className="-mt-1">
                  <p className="pb-3 pt-1 text-[12px] leading-snug text-[var(--color-muted)]">
                    show or hide rail items. drag to reorder them right in the
                    sidebar. pinned sites can be unpinned here or via their ⋯ menu.
                  </p>
                  {sidebar.items.map((it) => {
                    const isLink = it.kind.type === "link";
                    const app = it.kind.type === "app" ? SPAWN_BY_ID[it.kind.appId] : undefined;
                    const Icon = app?.icon ?? PanelLeft;
                    return (
                      <div
                        key={it.id}
                        className="flex items-center justify-between gap-3 border-b border-[var(--color-border)] py-2 last:border-0"
                      >
                        <div className="flex min-w-0 items-center gap-2.5">
                          {isLink && it.faviconUrl ? (
                            <img src={it.faviconUrl} alt="" className="h-4 w-4 shrink-0 rounded-sm" />
                          ) : (
                            <Icon size={14} className="shrink-0 text-[var(--color-muted)]" />
                          )}
                          <span
                            className="truncate text-[13px]"
                            style={{
                              color: it.hidden ? "var(--color-faint)" : "var(--color-text-2)",
                            }}
                          >
                            {it.label}
                          </span>
                          <span className="shrink-0 text-[10px] uppercase tracking-wide text-[var(--color-faint)]">
                            {it.group}
                          </span>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          {isLink ? (
                            <button
                              onClick={() => removeItem(it.id)}
                              title="unpin"
                              className="grid h-7 w-7 place-items-center rounded-md text-[var(--color-muted)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-danger)]"
                            >
                              <Trash2 size={13} />
                            </button>
                          ) : (
                            <button
                              onClick={() => toggleHidden(it.id, !it.hidden)}
                              title={it.hidden ? "show" : "hide"}
                              className="grid h-7 w-7 place-items-center rounded-md text-[var(--color-muted)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
                            >
                              {it.hidden ? <EyeOff size={14} /> : <Eye size={14} />}
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                  <div className="flex justify-end pt-3">
                    <button
                      onClick={() => resetSidebar()}
                      className="flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)]/50 px-3 py-1.5 text-[12px] text-[var(--color-text-2)] transition-colors hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)]"
                    >
                      <RotateCcw size={13} />
                      reset sidebar to default
                    </button>
                  </div>
                </div>
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
          )}
        </div>
      </div>
    </div>
  );
}
