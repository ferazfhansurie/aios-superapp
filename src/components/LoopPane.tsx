/**
 * LoopPane — firaz's dedicated control panel for every running AIOS loop (a
 * first-class pane, registered in CORE_PANE_TYPES + the SPAWN catalog like
 * `mission` / `ticket`). Supersedes the in-MissionBoard loops section: this is
 * the full surface.
 *
 * Rows come from loop_list (~/.aios/state/loops/*.meta + launchd state + last
 * log line) and reuse the SAME LoopRow control the board used — status pill,
 * start/stop toggle, inline cadence edit — so behavior stays in lockstep. The
 * pane adds room to breathe: a header with counts + refresh, and the full list
 * (not the compact board subset).
 *
 * NOTE (follow-up, ticket firaz-20260619-200309): a "+ new loop" creator (loop_create
 * Rust cmd + structured/NL form) lands on top of this pane next.
 */
import { useEffect, useState } from "react";
import { MessageSquare, Plus, Power, Repeat, RefreshCw, X } from "lucide-react";

import {
  addLoop,
  getLoopGlobalStatus,
  listLoops,
  setLoopGlobalDisabled,
  type LoopGlobalStatus,
  type LoopInfo,
} from "../lib/agents";
import { talkToOrchestrator } from "../lib/paneBus";
import { LoopRow } from "./MissionBoard";

export function LoopPane() {
  const [loops, setLoops] = useState<LoopInfo[]>([]);
  const [globalStatus, setGlobalStatus] = useState<LoopGlobalStatus>({
    disabled: false,
    disabledPath: "",
    disabledSince: null,
  });
  const [loading, setLoading] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [creating, setCreating] = useState(false);

  const refresh = async () => {
    setLoading(true);
    const [nextLoops, nextStatus] = await Promise.all([listLoops(), getLoopGlobalStatus()]);
    setLoops(nextLoops);
    setGlobalStatus(nextStatus);
    setLoading(false);
  };

  useEffect(() => {
    void refresh();
  }, []);

  const running = loops.filter((l) => (l.status ?? "running") === "running").length;
  const disabled = globalStatus.disabled;
  const since =
    typeof globalStatus.disabledSince === "number"
      ? new Date(globalStatus.disabledSince * 1000).toLocaleString(undefined, {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        })
      : null;

  const toggleGlobal = async () => {
    if (toggling) return;
    setToggling(true);
    try {
      const next = await setLoopGlobalDisabled(!disabled);
      setGlobalStatus(next);
      setLoops(await listLoops());
    } finally {
      setToggling(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--color-pane)] p-3">
      <div className="mb-2.5 flex flex-wrap items-center gap-2">
        <Repeat size={14} className="shrink-0 text-[var(--color-accent)]" />
        <span className="text-[12px] font-medium text-[var(--color-text)]">loops</span>
        <span className="text-[10px] text-[var(--color-faint)]">
          {disabled ? "globally paused" : `${running} running`} · {loops.length} total
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={!disabled}
          onClick={() => void toggleGlobal()}
          disabled={toggling}
          className={`ml-auto flex h-7 items-center gap-1.5 rounded-md border px-2 text-[10px] font-medium transition-colors disabled:opacity-50 ${
            disabled
              ? "border-[var(--color-danger)]/50 bg-[var(--color-danger)]/10 text-[var(--color-danger)]"
              : "border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text)] hover:border-[var(--color-accent)]/60"
          }`}
          title={disabled ? "enable every loop again" : "disable every loop until this is flipped back"}
        >
          <Power size={12} />
          {disabled ? "disabled" : "enabled"}
        </button>
        <button
          type="button"
          onClick={() => setCreating((v) => !v)}
          className="flex items-center gap-1 rounded px-1.5 py-1 text-[10px] text-[var(--color-muted)] transition-colors hover:text-[var(--color-text)]"
          title="create a new loop"
        >
          {creating ? <X size={12} /> : <Plus size={12} />}
          {creating ? "close" : "new loop"}
        </button>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading}
          className="flex items-center gap-1 rounded px-1.5 py-1 text-[10px] text-[var(--color-muted)] transition-colors hover:text-[var(--color-text)] disabled:opacity-50"
          title="reload loop state"
        >
          <RefreshCw size={11} className={loading ? "animate-spin" : ""} />
        </button>
      </div>

      {disabled && (
        <div className="mb-2.5 rounded-md border border-[var(--color-danger)]/35 bg-[var(--color-danger)]/10 px-2.5 py-2 text-[11px] text-[var(--color-danger)]">
          all loop ticks are disabled{since ? ` since ${since}` : ""}. flip the switch to resume.
        </div>
      )}

      {creating && (
        <NewLoopForm
          onCreated={() => {
            setCreating(false);
            void refresh();
          }}
        />
      )}

      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
        {loops.length === 0 ? (
          <div className="px-1 text-[11px] text-[var(--color-faint)]">
            no loops yet — create one with `aios-loop create &lt;name&gt; &lt;cadence&gt; &lt;command&gt;`.
          </div>
        ) : (
          loops.map((loop) => (
            <LoopRow key={loop.name} loop={loop} onChanged={() => void refresh()} />
          ))
        )}
      </div>
    </div>
  );
}

/** "+ new loop" creator — two ways in:
 *  • agent (the easy default): name + cadence + prompt + optional cwd → a
 *    scheduled `aios-agent <prompt> <cwd>` loop (most loops are exactly this).
 *  • describe: a natural-language box → opens the orchestrator with a starter so
 *    it mints the loop via aios-loop create (firaz reviews + sends; never auto). */
function NewLoopForm({ onCreated }: { onCreated: () => void }) {
  const [mode, setMode] = useState<"agent" | "describe">("agent");
  const [name, setName] = useState("");
  const [cadence, setCadence] = useState("30m");
  const [prompt, setPrompt] = useState("");
  const [cwd, setCwd] = useState("");
  const [desc, setDesc] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const createAgent = async () => {
    const n = name.trim();
    const c = cadence.trim();
    const p = prompt.trim();
    if (!n || !c || !p || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const command = ["aios-agent", p, ...(cwd.trim() ? [cwd.trim()] : [])];
      await addLoop(n, c, command);
      onCreated();
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const describeToOrchestrator = () => {
    const d = desc.trim();
    if (!d) return;
    // Hand the orchestrator a ready-to-send starter; firaz reviews + sends it.
    talkToOrchestrator(
      `mint a new AIOS loop for this and confirm it back to me: "${d}". ` +
        `use \`aios-loop create <name> <cadence> ...\` (most loops wrap an aios-agent spawn — ` +
        `\`aios-loop create <name> <cadence> aios-agent "<prompt>" <cwd>\`). pick a sensible name + cadence.`,
    );
    onCreated();
  };

  const tabCls = (active: boolean) =>
    `rounded px-2 py-0.5 text-[10px] font-medium transition-colors ${
      active
        ? "bg-[var(--color-accent)] text-[var(--color-bg)]"
        : "text-[var(--color-muted)] hover:text-[var(--color-text)]"
    }`;
  const inputCls =
    "w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-[12px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]";

  return (
    <div className="mb-2.5 rounded-lg border border-[var(--color-accent)]/40 bg-[var(--color-bg)]/40 p-2.5">
      <div className="mb-2 flex items-center gap-1">
        <button type="button" className={tabCls(mode === "agent")} onClick={() => setMode("agent")}>
          agent loop
        </button>
        <button type="button" className={tabCls(mode === "describe")} onClick={() => setMode("describe")}>
          describe it
        </button>
      </div>

      {mode === "agent" ? (
        <form
          className="flex flex-col gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            void createAgent();
          }}
        >
          <div className="flex gap-1.5">
            <input className={inputCls} placeholder="name (e.g. pr-watch)" value={name} onChange={(e) => setName(e.target.value)} />
            <input className="w-24 shrink-0 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-[12px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]" placeholder="30m" value={cadence} onChange={(e) => setCadence(e.target.value)} />
          </div>
          <input className={inputCls} placeholder="prompt — what the loop should do each fire" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
          <input className={inputCls} placeholder="cwd (optional, e.g. /Users/firazfhansurie/Repo/wrms)" value={cwd} onChange={(e) => setCwd(e.target.value)} />
          {err && <div className="text-[10px] text-[var(--color-danger)]">⚠ {err}</div>}
          <button
            type="submit"
            disabled={!name.trim() || !cadence.trim() || !prompt.trim() || busy}
            className="self-end rounded-md bg-[var(--color-accent)] px-2.5 py-1 text-[11px] font-medium text-[var(--color-bg)] transition-transform hover:scale-[1.03] disabled:opacity-40"
          >
            create loop
          </button>
        </form>
      ) : (
        <div className="flex flex-col gap-1.5">
          <textarea
            className={`${inputCls} h-16 resize-none`}
            placeholder="describe the loop — e.g. 'every 30m check open PRs on the wrms repos and summarize'"
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
          />
          <button
            type="button"
            onClick={describeToOrchestrator}
            disabled={!desc.trim()}
            className="flex items-center gap-1.5 self-end rounded-md bg-[var(--color-accent)] px-2.5 py-1 text-[11px] font-medium text-[var(--color-bg)] transition-transform hover:scale-[1.03] disabled:opacity-40"
          >
            <MessageSquare size={12} />
            hand to AIOS
          </button>
        </div>
      )}
    </div>
  );
}
