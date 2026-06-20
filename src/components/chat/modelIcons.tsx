/**
 * Per-engine identity glyphs for the chat pane — model picker, assistant bubbles,
 * pane header. Premium-minimalist: monochrome line marks that render in
 * `currentColor`, so the parent's text color (or an accent) tints them — NOT
 * full-color brand logos (those read as "third-party integration"; monochrome
 * reads "premium native"). One 1.5px stroke weight across all three. Generic
 * geometric marks, not trademark replicas: a sunburst for claude, a blossom for
 * codex, angle-brackets for opencode.
 *
 * Keyed off the engine on a `ChatModel`, so adding a model picks up its icon for
 * free (no per-model wiring). Always pair the icon with the text label — never
 * icon-only.
 */
import type { ReactElement } from "react";
import type { ChatModel } from "../../lib/chat";

type Engine = NonNullable<ChatModel["engine"]>;

// Brand-flavored colors — the "splash of color" each engine's mark brings, so the
// active engine pops on the dark UI instead of reading flat/monochrome. Claude's
// warm clay/coral, OpenAI's green, a violet for opencode.
const ENGINE_COLOR: Record<Engine, string> = {
  claude: "#D97757",
  codex: "#10A37F",
  opencode: "#A78BFA",
};

function ClaudeMark({ size = 14, color }: { size?: number; color: string }) {
  // sunburst — 8 spokes radiating from center (Anthropic-flavored)
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="1.6"
      strokeLinecap="round"
      aria-hidden="true"
    >
      {[0, 45, 90, 135].map((a) => (
        <line key={a} x1="12" y1="3.5" x2="12" y2="20.5" transform={`rotate(${a} 12 12)`} />
      ))}
    </svg>
  );
}

function CodexMark({ size = 14, color }: { size?: number; color: string }) {
  // blossom — three overlapping ellipses at 60° (OpenAI-flavored knot)
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="1.6"
      aria-hidden="true"
    >
      {[0, 60, 120].map((a) => (
        <ellipse key={a} cx="12" cy="12" rx="4" ry="9" transform={`rotate(${a} 12 12)`} />
      ))}
    </svg>
  );
}

function OpencodeMark({ size = 14, color }: { size?: number; color: string }) {
  // angle brackets — "open / code"
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="9 7 4 12 9 17" />
      <polyline points="15 7 20 12 15 17" />
    </svg>
  );
}

const MARKS: Record<Engine, (p: { size?: number; color: string }) => ReactElement> = {
  claude: ClaudeMark,
  codex: CodexMark,
  opencode: OpencodeMark,
};

/** Icon for a model's engine (omitted engine ⇒ claude). Returns null only for an
 *  unknown engine string, so callers can `{icon}` unconditionally. */
export function ModelIcon({
  model,
  size = 14,
}: {
  model: Pick<ChatModel, "engine">;
  size?: number;
}): ReactElement | null {
  const engine = (model.engine ?? "claude") as Engine;
  const Mark = MARKS[engine];
  return Mark ? <Mark size={size} color={ENGINE_COLOR[engine]} /> : null;
}

/** Same, addressed directly by engine — for assistant bubbles where only the
 *  engine string is in hand. */
export function EngineIcon({
  engine,
  size = 14,
}: {
  engine?: string | null;
  size?: number;
}): ReactElement | null {
  const key = (engine ?? "claude") as Engine;
  const Mark = MARKS[key];
  return Mark ? <Mark size={size} color={ENGINE_COLOR[key]} /> : null;
}
