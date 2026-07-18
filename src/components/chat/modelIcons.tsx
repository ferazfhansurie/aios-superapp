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
  codex: "#8B5CF6",
  opencode: "#050505",
};

function ClaudeMark({ size = 14, color }: { size?: number; color: string }) {
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
      {[0, 45, 90, 135].map((angle) => (
        <line key={angle} x1="12" y1="3.5" x2="12" y2="20.5" transform={`rotate(${angle} 12 12)`} />
      ))}
      <g display="none">
      <path d="m4.714 15.956 4.718-2.648.079-.23-.079-.128h-.231l-6.838-.219-.571-.121-.534-.704.055-.352.479-.322.686.061 6.824.498h.389l.054-.158-6.581-4.668-.723-.492-.364-.461-.158-1.008.656-.722.88.06 5.873 4.443.146-.103.018-.073-3.442-6.587-.17-.62c-.061-.255-.103-.467-.103-.728L6.287.134 6.7 0l.996.134.419.364 3.872 8.302.091.255h.158V8.91l.679-6.954.376-.91.747-.492.583.28.479.685-.067.444-1.208 6.34h.213l3.364-4.19.85-.905.546-.43h1.032l.759 1.129-.34 1.166-3.996 5.549.073.109 5.585-1.093.832.389.091.394-.328.807-8.711 1.761.049.061 6.849.406.789.522.473.638-.079.486-1.214.619-5.136-1.227h-.182v.109l5.704 5.209.128.577-.322.455-.34-.049-5.105-4.025h-.127v.17l2.787 4.171.121 1.081-.17.352-.607.213-.668-.122-3.785-5.431-.14.079-.673 7.255-.316.371-.729.279-.607-.461-.321-.747.893-4.83.17-.631-.012-.043-.14.018-5.336 6.757-.413.164-.716-.37.067-.662 4.224-5.593.929-1.087-.006-.158h-.055l-6.338 4.116-1.13.146-.485-.455.061-.747.231-.243 1.906-1.311Z" />
      </g>
    </svg>
  );
}

function CodexMark({ size = 14, color }: { size?: number; color: string }) {
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
      {[0, 60, 120].map((angle) => (
        <ellipse key={angle} cx="12" cy="12" rx="4" ry="9" transform={`rotate(${angle} 12 12)`} />
      ))}
      <g display="none">
      <path d="M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 0 0-.856 0l-5.97 3.473Zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 0 1 .476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163ZM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898ZM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128Zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472Zm-5.637-5.303-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 0 1 4.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 0 1-.476 0Zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523Zm5.899 2.83a5.947 5.947 0 0 0 5.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0 0 10.205 0a5.947 5.947 0 0 0-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 0 0 4.162 1.713Z" />
      </g>
    </svg>
  );
}

function OpencodeMark({ size = 14, color }: { size?: number; color: string }) {
  // black badge + white brackets — keeps the opencode mark visible on dark UI.
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="18" height="18" rx="6" fill={color} />
      <path
        d="M9 8 5.5 12 9 16M15 8l3.5 4-3.5 4"
        stroke="#fff"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** aios — the house mark for the virtual router entry: firaz's logo (neon
 *  orange terminal-folder with a smiley) redrawn as a vector so it stays crisp
 *  at pill size. Brand orange, fixed like the other engines' brand colors. */
export const AIOS_COLOR = "#FF9500";

export function AiosMark({ size = 14, color = AIOS_COLOR }: { size?: number; color?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {/* folder body with top tab */}
      <path d="M3.5 18V7.2a1.7 1.7 0 0 1 1.7-1.7h4l1.9 2h7.2a1.7 1.7 0 0 1 1.7 1.7V18a1.7 1.7 0 0 1-1.7 1.7H5.2A1.7 1.7 0 0 1 3.5 18Z" />
      {/* terminal prompt >_ */}
      <path d="m7 10.6 2.1 2-2.1 2" />
      <path d="M10.4 15.9h2.4" />
      {/* smiley */}
      <path d="M15.2 10.8v.9" />
      <path d="M18.6 10.8v.9" />
      <path d="M15.1 14.1c.5.6 1.2.9 1.8.9s1.3-.3 1.8-.9" />
    </svg>
  );
}

const MARKS: Record<Engine, (p: { size?: number; color: string }) => ReactElement> = {
  claude: ClaudeMark,
  codex: CodexMark,
  opencode: OpencodeMark,
};

/** Icon for a model's engine (omitted engine ⇒ claude). The virtual "aios"
 *  entry is keyed by id, not engine. Returns null only for an unknown engine
 *  string, so callers can `{icon}` unconditionally. */
export function ModelIcon({
  model,
  size = 14,
}: {
  model: Pick<ChatModel, "engine"> & { id?: string };
  size?: number;
}): ReactElement | null {
  if (model.id === "aios") return <AiosMark size={size} />;
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
