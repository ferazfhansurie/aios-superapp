/** Inline approval + AskUserQuestion cards — moved verbatim out of ChatPane.tsx
 *  (mechanical split, no behavior change). */
import { memo, useMemo, useState } from "react";
import { Check, CheckCheck, HelpCircle, ShieldQuestion, X } from "lucide-react";
import type { ApprovalDecision } from "../../lib/chat";
import type { ChatTurn } from "../../lib/chatStream";
import { previewArgs, type ToolTurn } from "./toolPresentation";

/**
 * Inline tool-approval card for a `can_use_tool` control request (non-bypass
 * modes). Allow once / Allow always / Deny → replied via the control protocol
 * (buildApprovalLine in chat.ts owns the exact shape). Once resolved the card
 * collapses to a one-line verdict so the transcript stays clean.
 */
export const ApprovalCard = memo(function ApprovalCard({
  turn,
  onResolve,
}: {
  turn: Extract<ChatTurn, { kind: "approval" }>;
  onResolve: (
    requestId: string,
    toolName: string,
    decision: ApprovalDecision,
  ) => void;
}) {
  const args = previewArgs(turn.input);

  if (turn.decision) {
    const denied = turn.decision === "deny";
    return (
      <div
        className={`flex items-center gap-2 rounded-xl border px-3.5 py-2 font-sans text-[12px] ${
          denied
            ? "border-[var(--color-danger)]/30 text-[var(--color-danger)]"
            : "border-[var(--color-success)]/30 text-[var(--color-success)]"
        }`}
      >
        {denied ? <X size={13} /> : <CheckCheck size={13} />}
        <span className="font-mono text-[11.5px] text-[var(--color-text-2)]">
          {turn.toolName}
        </span>
        <span className="opacity-80">
          {turn.decision === "allow"
            ? "allowed once"
            : turn.decision === "allow_always"
              ? "allowed for session"
              : "denied"}
        </span>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-[var(--aios-radius-card)] border border-[var(--color-warning-accent)] bg-[var(--color-warning-soft)]">
      <div className="flex items-center gap-2.5 px-3.5 pt-3 pb-2">
        <span className="grid h-6 w-6 shrink-0 place-items-center rounded-[var(--aios-radius-row)] bg-[var(--color-warning-accent)] text-[var(--color-warning-fg)]">
          <ShieldQuestion size={14} />
        </span>
        <span className="font-sans text-[12.5px] text-[var(--color-text)]">
          allow{" "}
          <span className="font-mono font-medium">{turn.toolName}</span>?
        </span>
      </div>
      {args && (
        <div className="mx-3.5 mb-2 truncate rounded-[var(--aios-radius-row)] bg-[var(--color-panel)] px-2.5 py-1.5 font-mono text-[11px] text-[var(--color-muted)]">
          {args}
        </div>
      )}
      <div className="flex items-center gap-2 px-3.5 pb-3">
        <button
          type="button"
          onClick={() => onResolve(turn.requestId, turn.toolName, "allow")}
          className="flex items-center gap-1.5 rounded-[var(--aios-radius-row)] bg-[var(--color-warning-accent)] px-3 py-1.5 font-sans text-[12px] font-medium text-[var(--color-warning-fg)] transition-colors focus-visible:outline-2 focus-visible:outline-[var(--color-focus)]"
        >
          <Check size={13} /> allow once
        </button>
        <button
          type="button"
          onClick={() =>
            onResolve(turn.requestId, turn.toolName, "allow_always")
          }
          className="flex items-center gap-1.5 rounded-[var(--aios-radius-row)] border border-[var(--color-warning-accent)] bg-[var(--color-warning-soft)] px-3 py-1.5 font-sans text-[12px] text-[var(--color-text)] transition-colors focus-visible:outline-2 focus-visible:outline-[var(--color-focus)]"
        >
          <CheckCheck size={13} /> allow always
        </button>
        <button
          type="button"
          onClick={() => onResolve(turn.requestId, turn.toolName, "deny")}
          className="flex items-center gap-1.5 rounded-[var(--aios-radius-row)] border border-[var(--color-border)] px-3 py-1.5 font-sans text-[12px] text-[var(--color-muted)] transition-colors hover:border-[var(--color-danger)]/40 hover:text-[var(--color-danger)] focus-visible:outline-2 focus-visible:outline-[var(--color-focus)]"
        >
          <X size={13} /> deny
        </button>
      </div>
    </div>
  );
});

// ── AskUserQuestion card ──────────────────────────────────────────────────────
//
// claude's AskUserQuestion tool can't prompt in headless stream-json mode — the
// CLI auto-dismisses it and ends the turn waiting for the answer as a follow-up.
// We pull the questions out of the tool_use input and render them as a real
// choice card (buttons for single-select, a checkbox list for multiSelect, plus
// a free-text fallback), then send the pick back as the next user turn.

export interface AUQOption { label: string; description?: string }
export interface AUQQuestion {
  question: string;
  header?: string;
  multiSelect: boolean;
  options: AUQOption[];
}

export function parseQuestions(input: Record<string, unknown>): AUQQuestion[] {
  const raw = (input as { questions?: unknown })?.questions;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((q) => {
      const o = (q ?? {}) as Record<string, unknown>;
      const options = Array.isArray(o.options)
        ? (o.options as unknown[])
            .map((opt) => {
              const oo = (opt ?? {}) as Record<string, unknown>;
              return {
                label: String(oo.label ?? "").trim(),
                description: oo.description ? String(oo.description) : undefined,
              };
            })
            .filter((opt) => opt.label)
        : [];
      return {
        question: String(o.question ?? "").trim(),
        header: o.header ? String(o.header) : undefined,
        multiSelect: Boolean(o.multiSelect),
        options,
      };
    })
    .filter((q) => q.question || q.options.length);
}

/** Turn the selected option labels (+ any free-text) into the message we send
 *  back to claude. One question → just the answer; several → "Header: answer"
 *  lines so the model can map each reply to its question. */
export function composeAnswer(
  questions: AUQQuestion[],
  sel: Record<number, string[]>,
  free: Record<number, string>,
): string {
  const parts = questions.map((q, i) => {
    const picks = [...(sel[i] ?? [])];
    const f = (free[i] ?? "").trim();
    if (f) picks.push(f);
    const ans = picks.join(", ") || "no preference";
    return questions.length > 1 && q.header ? `${q.header}: ${ans}` : ans;
  });
  return parts.join("\n");
}

export const QuestionCard = memo(function QuestionCard({
  turn,
  answered,
  onAnswer,
}: {
  turn: ToolTurn;
  answered?: string;
  onAnswer: (turnId: string, text: string) => void;
}) {
  const questions = useMemo(() => parseQuestions(turn.input), [turn.input]);
  const [sel, setSel] = useState<Record<number, string[]>>({});
  const [free, setFree] = useState<Record<number, string>>({});

  if (answered != null) {
    return (
      <div className="flex items-start gap-2 rounded-xl border border-[var(--color-success)]/30 px-3.5 py-2 font-sans text-[12px]">
        <CheckCheck size={13} className="mt-0.5 shrink-0 text-[var(--color-success)]" />
        <span className="whitespace-pre-wrap text-[var(--color-text-2)]">{answered}</span>
      </div>
    );
  }
  if (questions.length === 0) return null;

  // one single-select question → tapping an option submits immediately (fast
  // path). Anything else accumulates picks behind a "send answer" button.
  const single = questions.length === 1 && !questions[0].multiSelect;

  const toggle = (qi: number, label: string, multi: boolean) => {
    if (single) {
      onAnswer(turn.id, label);
      return;
    }
    setSel((prev) => {
      const cur = prev[qi] ?? [];
      if (multi) {
        return {
          ...prev,
          [qi]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label],
        };
      }
      return { ...prev, [qi]: [label] };
    });
  };

  const submit = () => onAnswer(turn.id, composeAnswer(questions, sel, free));

  return (
    <div className="overflow-hidden rounded-xl border border-[var(--color-accent)]/40 bg-[var(--color-accent-soft)]">
      <div className="flex items-center gap-2.5 px-3.5 pt-3 pb-1">
        <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-[var(--color-bg)]/40 text-[var(--color-accent)]">
          <HelpCircle size={14} />
        </span>
        <span className="font-sans text-[12.5px] text-[var(--color-text)]">
          claude is asking
        </span>
      </div>
      <div className="flex flex-col gap-3.5 px-3.5 pb-3 pt-1.5">
        {questions.map((q, qi) => (
          <div key={qi} className="flex flex-col gap-1.5">
            <div className="font-sans text-[13.5px] leading-snug text-[var(--color-text)]">
              {q.question}
            </div>
            <div className="flex flex-wrap gap-2">
              {q.options.map((o) => {
                const active = (sel[qi] ?? []).includes(o.label);
                return (
                  <button
                    key={o.label}
                    type="button"
                    title={o.description}
                    onClick={() => toggle(qi, o.label, q.multiSelect)}
                    className={`flex items-center gap-1.5 rounded-[var(--aios-radius-pill)] border px-3.5 py-1.5 text-[13px] font-medium transition-colors ${
                      active
                        ? "border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-accent-fg)]"
                        : "border-[var(--color-border-strong)] bg-[var(--color-panel-2)] text-[var(--color-text)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
                    }`}
                  >
                    {q.multiSelect && (
                      <span
                        className={`grid h-3.5 w-3.5 place-items-center rounded-[4px] border ${
                          active
                            ? "border-[var(--color-bg)]/60 bg-[var(--color-bg)]/20"
                            : "border-[var(--color-border-strong)]"
                        }`}
                      >
                        {active && <Check size={10} />}
                      </span>
                    )}
                    {o.label}
                  </button>
                );
              })}
            </div>
            <input
              value={free[qi] ?? ""}
              onChange={(e) =>
                setFree((p) => ({ ...p, [qi]: e.target.value }))
              }
              onKeyDown={(e) => {
                if (e.key === "Enter" && single) {
                  e.preventDefault();
                  const typed = (e.target as HTMLInputElement).value.trim();
                  if (typed) onAnswer(turn.id, typed);
                }
              }}
              placeholder="or type your own…"
              className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]/40 px-2.5 py-1.5 font-sans text-[12.5px] text-[var(--color-text)] outline-none placeholder:text-[var(--color-faint)] focus:border-[var(--color-accent)]/50"
            />
          </div>
        ))}
        <div className="flex items-center gap-2 pt-0.5">
          {!single && (
            <button
              type="button"
              onClick={submit}
              className="flex items-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-3 py-1.5 font-sans text-[12px] font-medium text-[var(--color-accent-fg)] transition-colors hover:bg-[var(--color-accent-hover)] hover:text-[var(--color-accent-hover-fg)]"
            >
              <Check size={13} /> send answer
            </button>
          )}
          <button
            type="button"
            onClick={() => onAnswer(turn.id, "skip this question")}
            className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 font-sans text-[12px] text-[var(--color-muted)] transition-colors hover:border-[var(--color-border-strong)] hover:text-[var(--color-text-2)]"
          >
            skip
          </button>
        </div>
      </div>
    </div>
  );
});
