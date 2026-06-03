import { type CSSProperties, useEffect, useMemo, useState } from "react";
import {
  ACCENT_ORDER,
  ACCENT_PRESETS,
  accentToHex,
  getAccent,
  setAccent,
  subscribeAccent,
  type Accent,
} from "../lib/theme";
import {
  calmPet,
  flushPet,
  feedPet,
  getPetState,
  subscribePetState,
  type PetState,
} from "../lib/pet";

const METERS: Array<{
  key: keyof Pick<PetState, "health" | "hunger" | "bloat" | "stress">;
  label: string;
  hint: string;
}> = [
  { key: "health", label: "health", hint: "core stability" },
  { key: "hunger", label: "hunger", hint: "meal level" },
  { key: "bloat", label: "bloat", hint: "memory / token load" },
  { key: "stress", label: "stress", hint: "CPU + context pressure" },
];

const PET_VARIANT_KEY = "aios.pet.variant.v2";
const PET_LEGACY_VARIANT_KEY = "aios.pet.variant.v1";
const PET_REROLL_KEY = "aios.pet.rerolls.v1";
const PET_ONBOARDING_KEY = "aios.pet.onboarded.v1";
const PET_REROLL_DAILY_LIMIT = 12;

type PetShape = "brick" | "totem" | "mush" | "wide" | "bean" | "gem" | "shell" | "squat";
type PetEnvironment = "workshop" | "greenhouse" | "orbital" | "archive" | "arcade" | "lagoon" | "forge" | "studio";
type PetActivity = "coding" | "celebrating" | "foraging" | "compressing" | "cooling" | "napping" | "repairing";
type PetTopper = "cap" | "horns" | "sprout" | "crown" | "halo" | "visor" | "none";
type PetPattern = "bolt" | "spots" | "stripe" | "panel" | "star" | "cheeks" | "none";
type PetTail = "none" | "stub" | "spark" | "leaf" | "ribbon";

interface PetVariant {
  tone: number;
  shape: PetShape;
  eyes: 1 | 2 | 3 | 4;
  legs: 2 | 3 | 4 | 5 | 6;
  environment: PetEnvironment;
  topper: PetTopper;
  pattern: PetPattern;
  tail: PetTail;
}

interface PetRerollBank {
  day: string;
  used: number;
}

const THEME_TONES = [
  {
    name: "core",
    primary: "var(--color-accent)",
    shadow: "color-mix(in srgb, var(--color-accent) 48%, black)",
    accent: "color-mix(in srgb, var(--color-accent) 38%, white)",
    outline: "color-mix(in srgb, var(--color-bg) 72%, black)",
    eye: "var(--color-accent-fg)",
  },
  {
    name: "bright",
    primary: "color-mix(in srgb, var(--color-accent) 72%, white)",
    shadow: "color-mix(in srgb, var(--color-accent) 56%, black)",
    accent: "var(--color-accent)",
    outline: "color-mix(in srgb, var(--color-bg) 78%, black)",
    eye: "color-mix(in srgb, var(--color-text) 84%, black)",
  },
  {
    name: "deep",
    primary: "color-mix(in srgb, var(--color-accent) 76%, black)",
    shadow: "color-mix(in srgb, var(--color-accent) 42%, black)",
    accent: "color-mix(in srgb, var(--color-accent) 54%, white)",
    outline: "color-mix(in srgb, var(--color-bg) 82%, black)",
    eye: "var(--color-accent-fg)",
  },
  {
    name: "soft",
    primary: "color-mix(in srgb, var(--color-accent) 46%, var(--color-panel))",
    shadow: "color-mix(in srgb, var(--color-accent) 44%, black)",
    accent: "color-mix(in srgb, var(--color-accent) 64%, white)",
    outline: "color-mix(in srgb, var(--color-text) 68%, var(--color-bg))",
    eye: "color-mix(in srgb, var(--color-text) 92%, black)",
  },
  {
    name: "mono",
    primary: "color-mix(in srgb, var(--color-accent) 62%, var(--color-panel-2))",
    shadow: "color-mix(in srgb, var(--color-accent) 36%, var(--color-bg))",
    accent: "color-mix(in srgb, var(--color-accent) 76%, var(--color-text))",
    outline: "color-mix(in srgb, var(--color-bg) 86%, black)",
    eye: "var(--color-text)",
  },
  {
    name: "glow",
    primary: "color-mix(in srgb, var(--color-accent) 84%, var(--color-highlight))",
    shadow: "color-mix(in srgb, var(--color-accent) 50%, black)",
    accent: "color-mix(in srgb, var(--color-accent) 34%, white)",
    outline: "color-mix(in srgb, var(--color-bg) 78%, black)",
    eye: "color-mix(in srgb, var(--color-accent-fg) 86%, var(--color-text))",
  },
] as const;

const SHAPES: PetShape[] = ["brick", "totem", "mush", "wide", "bean", "gem", "shell", "squat"];
const ENVIRONMENTS: PetEnvironment[] = ["workshop", "greenhouse", "orbital", "archive", "arcade", "lagoon", "forge", "studio"];
const TOPPERS: PetTopper[] = ["cap", "horns", "sprout", "crown", "halo", "visor", "none"];
const PATTERNS: PetPattern[] = ["bolt", "spots", "stripe", "panel", "star", "cheeks", "none"];
const TAILS: PetTail[] = ["none", "stub", "spark", "leaf", "ribbon"];
const EYES = [1, 2, 3, 4] as const;
const LEGS = [2, 3, 4, 5, 6] as const;

const ACTIVITY_BY_MOOD: Record<PetState["mood"], { label: string; activity: PetActivity }> = {
  happy: { label: "celebrating", activity: "celebrating" },
  content: { label: "building", activity: "coding" },
  hungry: { label: "foraging", activity: "foraging" },
  bloated: { label: "compressing memory", activity: "compressing" },
  overloaded: { label: "cooling down", activity: "cooling" },
  tired: { label: "napping", activity: "napping" },
  critical: { label: "repairing", activity: "repairing" },
};

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)] ?? items[0];
}

function isOneOf<T extends string | number>(items: readonly T[], value: unknown): value is T {
  return items.includes(value as T);
}

function makeVariant(): PetVariant {
  return {
    tone: Math.floor(Math.random() * THEME_TONES.length),
    shape: pick(SHAPES),
    eyes: pick(EYES),
    legs: pick(LEGS),
    environment: pick(ENVIRONMENTS),
    topper: pick(TOPPERS),
    pattern: pick(PATTERNS),
    tail: pick(TAILS),
  };
}

function normalizeVariant(parsed: Partial<PetVariant> | null): PetVariant | null {
  const legacyPalette = (parsed as Partial<PetVariant> & { palette?: number } | null)?.palette;
  const tone = Number.isInteger(parsed?.tone)
    ? parsed!.tone!
    : Number.isInteger(legacyPalette)
      ? legacyPalette!
      : Math.floor(Math.random() * THEME_TONES.length);
  if (!parsed) {
    return null;
  }
  return {
    tone: Math.abs(tone) % THEME_TONES.length,
    shape: isOneOf(SHAPES, parsed.shape) ? parsed.shape : pick(SHAPES),
    eyes: isOneOf(EYES, parsed.eyes) ? parsed.eyes : pick(EYES),
    legs: isOneOf(LEGS, parsed.legs) ? parsed.legs : pick(LEGS),
    environment: isOneOf(ENVIRONMENTS, parsed.environment) ? parsed.environment : pick(ENVIRONMENTS),
    topper: isOneOf(TOPPERS, parsed.topper) ? parsed.topper : pick(TOPPERS),
    pattern: isOneOf(PATTERNS, parsed.pattern) ? parsed.pattern : pick(PATTERNS),
    tail: isOneOf(TAILS, parsed.tail) ? parsed.tail : pick(TAILS),
  };
}

function readVariant(): PetVariant {
  try {
    const raw = localStorage.getItem(PET_VARIANT_KEY) || localStorage.getItem(PET_LEGACY_VARIANT_KEY);
    const parsed = JSON.parse(raw || "null") as Partial<PetVariant> | null;
    const normalized = normalizeVariant(parsed);
    if (normalized) {
      saveVariant(normalized);
      return normalized;
    }
  } catch {
    /* create below */
  }
  const next = makeVariant();
  try {
    localStorage.setItem(PET_VARIANT_KEY, JSON.stringify(next));
  } catch {
    /* unavailable */
  }
  return next;
}

function hasSavedVariant(): boolean {
  try {
    return Boolean(localStorage.getItem(PET_VARIANT_KEY) || localStorage.getItem(PET_LEGACY_VARIANT_KEY));
  } catch {
    return true;
  }
}

function saveVariant(next: PetVariant) {
  try {
    localStorage.setItem(PET_VARIANT_KEY, JSON.stringify(next));
  } catch {
    /* unavailable */
  }
}

function readOnboardingDone(): boolean {
  try {
    return localStorage.getItem(PET_ONBOARDING_KEY) === "done";
  } catch {
    return true;
  }
}

function saveOnboardingDone() {
  try {
    localStorage.setItem(PET_ONBOARDING_KEY, "done");
  } catch {
    /* unavailable */
  }
}

function todayKey(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function readRerollUsed(): number {
  try {
    const parsed = JSON.parse(localStorage.getItem(PET_REROLL_KEY) || "null") as Partial<PetRerollBank> | null;
    if (parsed?.day === todayKey() && Number.isInteger(parsed.used)) {
      return Math.max(0, Math.min(PET_REROLL_DAILY_LIMIT, parsed.used!));
    }
  } catch {
    /* create below */
  }
  return 0;
}

function saveRerollUsed(used: number) {
  try {
    localStorage.setItem(PET_REROLL_KEY, JSON.stringify({ day: todayKey(), used }));
  } catch {
    /* unavailable */
  }
}

function meterTone(value: number, key: keyof Pick<PetState, "health" | "hunger" | "bloat" | "stress">) {
  if (key === "health" || key === "hunger") {
    if (value >= 72) return "var(--color-success)";
    if (value >= 44) return "var(--color-warning)";
    return "var(--color-danger)";
  }
  if (value <= 35) return "var(--color-success)";
  if (value <= 62) return "var(--color-warning)";
  return "var(--color-danger)";
}

function MoodText({
  state,
  variant,
  activity,
}: {
  state: PetState;
  variant: PetVariant;
  activity: { label: string };
}) {
  const tone = THEME_TONES[variant.tone] ?? THEME_TONES[0];
  return (
    <div className="pet-status-chip">
      <span>{state.label}</span>
      <span className="pet-status-sub">
        {activity.label} · theme locked · {tone.name} · {variant.environment} · {variant.topper} {variant.shape} · {variant.pattern} · {variant.eyes}e/{variant.legs}l
      </span>
    </div>
  );
}

function Meter({
  label,
  hint,
  value,
  tone,
}: {
  label: string;
  hint: string;
  value: number;
  tone: string;
}) {
  return (
    <div className="pet-meter">
      <div className="pet-meter-head">
        <span className="pet-meter-label">{label}</span>
        <span>{hint}</span>
      </div>
      <div className="pet-meter-track">
        <div
          className="pet-meter-fill"
          style={{
            width: `${value}%`,
            backgroundColor: tone,
          }}
        />
      </div>
      <span className="pet-meter-value">{Math.round(value)} / 100</span>
    </div>
  );
}

function makeSpriteStyle(variant: PetVariant, breatheSpeed = "3.6s") {
  const tone = THEME_TONES[variant.tone] ?? THEME_TONES[0];
  return {
    "--pet-breath": breatheSpeed,
    "--pet-primary": tone.primary,
    "--pet-shadow": tone.shadow,
    "--pet-accent": tone.accent,
    "--pet-outline": tone.outline,
    "--pet-eye": tone.eye,
    "--pet-leg-count": variant.legs,
  } as CSSProperties;
}

function PetSprite({
  variant,
  visualMood,
  style,
  compact = false,
}: {
  variant: PetVariant;
  visualMood: string;
  style: CSSProperties;
  compact?: boolean;
}) {
  return (
    <div
      className={`pet-pixel ${compact ? "pet-pixel--starter" : ""} pet-pixel--${visualMood}`}
      style={style}
      aria-hidden={compact}
      aria-label={compact ? undefined : `aios pixel pet mood ${visualMood}`}
    >
      <div className="pet-pixel-shadow" />
      <div className={`pet-pixel-tail pet-pixel-tail--${variant.tail}`} />
      <div className={`pet-pixel-body pet-pixel-body--${variant.shape}`}>
        <div className={`pet-pixel-topper pet-pixel-topper--${variant.topper}`} />
        <div className="pet-pixel-ear pet-pixel-ear-left" />
        <div className="pet-pixel-ear pet-pixel-ear-right" />
        <div className={`pet-pixel-eyes pet-pixel-eyes--${variant.eyes}`}>
          {Array.from({ length: variant.eyes }, (_, i) => (
            <span key={i} className="pet-pixel-eye" />
          ))}
        </div>
        <div className="pet-pixel-mouth" />
        <div className={`pet-pixel-pattern pet-pixel-pattern--${variant.pattern}`} />
      </div>
      <div className="pet-pixel-legs">
        {Array.from({ length: variant.legs }, (_, i) => (
          <span key={i} className="pet-pixel-leg" />
        ))}
      </div>
    </div>
  );
}

export function PetPane() {
  const [state, setState] = useState(() => getPetState());
  const [showHatchOnboarding, setShowHatchOnboarding] = useState(() => !hasSavedVariant() && !readOnboardingDone());
  const [variant, setVariant] = useState(readVariant);
  const [accent, setAccentState] = useState<Accent>(getAccent);
  const [rerollUsed, setRerollUsed] = useState(readRerollUsed);
  const [starterVariants, setStarterVariants] = useState<[PetVariant, PetVariant, PetVariant]>(() => [
    makeVariant(),
    makeVariant(),
    makeVariant(),
  ]);

  useEffect(() => {
    const unsub = subscribePetState((next) => setState(next));
    return unsub;
  }, []);

  useEffect(() => subscribeAccent(setAccentState), []);

  const breatheSpeed = useMemo(() => (state.mood === "critical" ? "1.7s" : "3.6s"), [state.mood]);
  const visualMood = state.mood === "happy" ? "happy" : state.mood === "content" ? "content" : state.mood;
  const activity = ACTIVITY_BY_MOOD[state.mood];
  const rerollsLeft = Math.max(0, PET_REROLL_DAILY_LIMIT - rerollUsed);
  const spriteStyle = makeSpriteStyle(variant, breatheSpeed);
  const reroll = () => {
    if (rerollsLeft <= 0) return;
    const next = makeVariant();
    const nextUsed = Math.min(PET_REROLL_DAILY_LIMIT, rerollUsed + 1);
    saveVariant(next);
    saveRerollUsed(nextUsed);
    setVariant(next);
    setRerollUsed(nextUsed);
  };
  const finishOnboarding = () => {
    saveOnboardingDone();
    setShowHatchOnboarding(false);
  };
  const chooseStarter = (next: PetVariant) => {
    saveVariant(next);
    setVariant(next);
    finishOnboarding();
  };
  const shuffleStarters = () => setStarterVariants([makeVariant(), makeVariant(), makeVariant()]);
  const activeAccentHex = accentToHex(accent);

  return (
    <div className="pet-pane">
      {showHatchOnboarding && (
        <div className="pet-hatch-onboarding">
          <div className="pet-hatch-copy">
            <span className="pet-hatch-kicker">first hatch</span>
            <strong>choose your shell style</strong>
          </div>
          <div className="pet-hatch-theme-row" aria-label="hatch theme color">
            {ACCENT_ORDER.map((preset) => {
              const hex = ACCENT_PRESETS[preset];
              const active = activeAccentHex === hex;
              return (
                <button
                  key={preset}
                  type="button"
                  className={`pet-hatch-swatch ${active ? "pet-hatch-swatch--active" : ""}`}
                  style={{ backgroundColor: hex }}
                  onClick={() => setAccent(preset)}
                  aria-label={`use ${preset} theme`}
                />
              );
            })}
          </div>
          <div className="pet-starter-grid">
            {starterVariants.map((starter, index) => {
              const starterTone = THEME_TONES[starter.tone] ?? THEME_TONES[0];
              return (
                <button
                  key={`${starter.shape}-${starter.environment}-${starter.topper}-${starter.pattern}-${starter.tail}-${index}`}
                  type="button"
                  className="pet-starter-card"
                  onClick={() => chooseStarter(starter)}
                >
                  <span className={`pet-starter-preview pet-canvas--${starter.environment}`} style={makeSpriteStyle(starter)}>
                    <PetSprite variant={starter} visualMood="content" style={makeSpriteStyle(starter)} compact />
                  </span>
                  <span>{starter.environment}</span>
                  <small>
                    {starterTone.name} · {starter.topper} · {starter.pattern}
                  </small>
                </button>
              );
            })}
          </div>
          <div className="pet-hatch-onboarding-actions">
            <button type="button" className="pet-action-btn" onClick={shuffleStarters}>
              shuffle starters
            </button>
            <button type="button" className="pet-action-btn" onClick={finishOnboarding}>
              keep current
            </button>
          </div>
        </div>
      )}

      <div className={`pet-canvas pet-canvas--${variant.environment}`} style={spriteStyle}>
        <div className="pet-world" aria-label={`aios pet room: ${activity.label}`}>
          <div className="pet-world-sky">
            <span className="pet-world-star pet-world-star-a" />
            <span className="pet-world-star pet-world-star-b" />
            <span className="pet-world-orb" />
          </div>
          <div className="pet-world-backdrop">
            <span className="pet-prop pet-prop--shelf" />
            <span className="pet-prop pet-prop--plant" />
            <span className="pet-prop pet-prop--console" />
            <span className="pet-prop pet-prop--stack" />
            <span className="pet-prop pet-prop--beacon" />
          </div>
          <div className={`pet-job pet-job--${activity.activity}`}>
            <span className="pet-job-screen" />
            <span className="pet-job-block pet-job-block-a" />
            <span className="pet-job-block pet-job-block-b" />
            <span className="pet-job-pellet" />
            <span className="pet-job-z pet-job-z-a" />
            <span className="pet-job-z pet-job-z-b" />
          </div>
          <div className={`pet-world-avatar pet-world-avatar--${activity.activity}`}>
            <PetSprite variant={variant} visualMood={visualMood} style={spriteStyle} />
          </div>
          <div className="pet-world-floor">
            <span />
            <span />
            <span />
            <span />
            <span />
          </div>
        </div>
      </div>

      <div className="pet-control">
        <MoodText state={state} variant={variant} activity={activity} />
        <div className="pet-actions">
          <span className="pet-reroll-bank">
            {rerollsLeft} hatch roll{rerollsLeft === 1 ? "" : "s"} left today
          </span>
          <button type="button" className="pet-action-btn" onClick={reroll} disabled={rerollsLeft <= 0}>
            reroll
          </button>
          <button type="button" className="pet-action-btn" onClick={feedPet}>
            feed
          </button>
          <button type="button" className="pet-action-btn" onClick={flushPet}>
            flush memory
          </button>
          <button type="button" className="pet-action-btn" onClick={calmPet}>
            cool down
          </button>
        </div>
      </div>

      <div className="pet-meters">
        {METERS.map((m) => {
          const value = state[m.key];
          return (
            <Meter
              key={m.key}
              label={m.label}
              hint={m.hint}
              value={value}
              tone={meterTone(value, m.key)}
            />
          );
        })}
      </div>
    </div>
  );
}

export function PetDashboardCompanion({
  onOpenPet,
  onTalkToJarvis,
}: {
  onOpenPet: () => void;
  onTalkToJarvis: (seed: string) => void;
}) {
  const [state, setState] = useState(() => getPetState());
  const [variant] = useState(readVariant);

  useEffect(() => {
    const unsub = subscribePetState((next) => setState(next));
    return unsub;
  }, []);

  const breatheSpeed = state.mood === "critical" ? "1.7s" : "3.6s";
  const visualMood = state.mood === "happy" ? "happy" : state.mood === "content" ? "content" : state.mood;
  const activity = ACTIVITY_BY_MOOD[state.mood];
  const spriteStyle = makeSpriteStyle(variant, breatheSpeed);
  const needsCare = state.mood === "critical" || state.mood === "overloaded" || state.mood === "bloated";

  return (
    <section className="pet-dashboard">
      <div className="pet-dashboard-head">
        <div>
          <div className="pet-dashboard-kicker">pet system</div>
          <div className="pet-dashboard-title">{state.label}</div>
          <div className="pet-dashboard-sub">{activity.label} · health {Math.round(state.health)} · stress {Math.round(state.stress)}</div>
        </div>
        <button type="button" className="pet-action-btn" onClick={onOpenPet}>
          inspect
        </button>
      </div>

      <div className={`pet-dashboard-canvas pet-canvas pet-canvas--${variant.environment}`} style={spriteStyle}>
        <div className="pet-world" aria-label={`aios pet dashboard companion: ${activity.label}`}>
          <div className="pet-world-sky">
            <span className="pet-world-star pet-world-star-a" />
            <span className="pet-world-star pet-world-star-b" />
            <span className="pet-world-orb" />
          </div>
          <div className="pet-world-backdrop">
            <span className="pet-prop pet-prop--shelf" />
            <span className="pet-prop pet-prop--console" />
            <span className="pet-prop pet-prop--beacon" />
          </div>
          <div className={`pet-job pet-job--${activity.activity}`}>
            <span className="pet-job-screen" />
            <span className="pet-job-block pet-job-block-a" />
            <span className="pet-job-block pet-job-block-b" />
            <span className="pet-job-pellet" />
            <span className="pet-job-z pet-job-z-a" />
            <span className="pet-job-z pet-job-z-b" />
          </div>
          <div className={`pet-world-avatar pet-world-avatar--${activity.activity}`}>
            <PetSprite variant={variant} visualMood={visualMood} style={spriteStyle} />
          </div>
          <div className="pet-world-floor">
            <span />
            <span />
            <span />
            <span />
            <span />
          </div>
        </div>
      </div>

      <div className="pet-dashboard-actions">
        <button type="button" className="pet-action-btn" onClick={feedPet}>
          feed
        </button>
        <button type="button" className="pet-action-btn" onClick={flushPet}>
          flush memory
        </button>
        <button type="button" className="pet-action-btn" onClick={calmPet}>
          cool down
        </button>
        {needsCare && (
          <button
            type="button"
            className="pet-action-btn"
            onClick={() => onTalkToJarvis(`pet system is ${state.label}. diagnose what changed in recent chat, token, error, and agent pressure.`)}
          >
            ask jarvis
          </button>
        )}
      </div>
    </section>
  );
}
