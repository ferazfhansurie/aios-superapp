/** Dependency-free markdown renderer for assistant bubbles — moved verbatim out
 *  of ChatPane.tsx (mechanical split, no behavior change). CopyButton lives here
 *  (not ChatTranscript) because CodeBlock uses it — keeps the modules acyclic. */
import { memo, useMemo, useState } from "react";
import { Check, Copy, Globe, Terminal } from "lucide-react";
import { openUrlInPane, spawnPane, taskSpawnContext } from "../../lib/paneBus";
import { isHttpPaneTarget, isPaneFileTarget } from "../../lib/paneRouting";
import { useChatCwd, useChatFileOpener, useChatTaskId } from "./chatContext";

/** Copy-to-clipboard button with a brief check confirmation. */
export function CopyButton({
  text,
  size = 13,
  title = "copy",
  className,
}: {
  text: string;
  size?: number;
  title?: string;
  className?: string;
}) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      title={title}
      onClick={() => {
        navigator.clipboard?.writeText(text).then(
          () => {
            setDone(true);
            setTimeout(() => setDone(false), 1200);
          },
          () => {},
        );
      }}
      className={
        className ??
        "grid h-6 w-6 place-items-center rounded-md text-[var(--color-faint)] transition-colors hover:bg-[var(--color-panel)] hover:text-[var(--color-text)]"
      }
    >
      {done ? (
        <Check size={size} className="text-[var(--color-success)]" />
      ) : (
        <Copy size={size} />
      )}
    </button>
  );
}

/** Parse the WA-style `[[btn: a | b | c]]` choice sentinel out of an assistant
 *  message: returns the prose with the sentinel stripped + up to 3 button
 *  labels. Mirrors the bridge's WhatsApp interactive-button behavior so a choice
 *  offered in chat is tappable here too, not dead literal text. */
export function parseButtons(text: string): { body: string; buttons: string[] } {
  const m = text.match(/\[\[btn:\s*([^\]]+?)\s*\]\]/i);
  if (!m) return { body: text, buttons: [] };
  const buttons = m[1]
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 5);
  return { body: text.replace(m[0], "").trimEnd(), buttons };
}

// ── markdown renderer (dependency-free, partial-stream safe) ──────────────────
//
// Deliberately small: blocks split on fenced ``` first (so a half-open fence
// during streaming just renders as an open code block, never throws), then each
// non-code block is rendered with inline spans for `code`, **bold**, *italic*,
// and [links](url). Headings + bullet / numbered lists are handled at the line
// level. Anything it doesn't recognize falls through as plain text.

/** Split text into fenced-code and non-code segments. Tolerates an unclosed
 *  trailing fence (mid-stream) by treating the remainder as an open block. */
export function splitFences(
  text: string,
): Array<{ code: true; lang: string; body: string } | { code: false; body: string }> {
  const out: Array<
    { code: true; lang: string; body: string } | { code: false; body: string }
  > = [];
  const re = /```([^\n`]*)\n?([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push({ code: false, body: text.slice(last, m.index) });
    out.push({ code: true, lang: (m[1] || "").trim(), body: m[2] ?? "" });
    last = re.lastIndex;
  }
  const rest = text.slice(last);
  // an unclosed fence while streaming: render what we have as an open code block
  const openIdx = rest.indexOf("```");
  if (openIdx >= 0) {
    if (openIdx > 0) out.push({ code: false, body: rest.slice(0, openIdx) });
    const after = rest.slice(openIdx + 3);
    const nl = after.indexOf("\n");
    const lang = (nl >= 0 ? after.slice(0, nl) : after).trim();
    const body = nl >= 0 ? after.slice(nl + 1) : "";
    out.push({ code: true, lang, body });
  } else if (rest) {
    out.push({ code: false, body: rest });
  }
  return out;
}

export const Markdown = memo(function Markdown({
  text,
  onOpenUrl,
  streaming = false,
}: {
  text: string;
  onOpenUrl?: (url: string) => void;
  /** While the bubble is still streaming, skip the expensive block/inline parse
   *  (which re-scans the WHOLE growing message every frame → O(n²) over the turn,
   *  the dominant streaming jank). Render prose as plain pre-wrap text and only
   *  keep the cheap fence split so code blocks still look right. The full
   *  markdown parse runs ONCE on settle (streaming → false). */
  streaming?: boolean;
}) {
  const segments = useMemo(() => splitFences(text), [text]);
  return (
    <div className="flex flex-col gap-2">
      {segments.map((seg, i) =>
        seg.code ? (
          <CodeBlock key={i} lang={seg.lang} body={seg.body} />
        ) : streaming ? (
          <p key={i} className="whitespace-pre-wrap break-words">
            {seg.body}
          </p>
        ) : (
          <MarkdownBlocks key={i} text={seg.body} onOpenUrl={onOpenUrl} />
        ),
      )}
    </div>
  );
});

/** Shell-ish fences get a "run in terminal" affordance. Single-statement blocks
 *  (no embedded newline once trimmed) seed + run directly; multi-line blocks open
 *  a terminal rooted at the session cwd and let the user run it (we still seed the
 *  whole block so it's typed in). */
export const SHELL_LANGS = new Set(["bash", "sh", "shell", "zsh", "console", "shell-session"]);

export const CodeBlock = memo(function CodeBlock({ lang, body }: { lang: string; body: string }) {
  // strip a single trailing newline so the block isn't bottom-heavy
  const code = body.replace(/\n$/, "");
  const cwd = useChatCwd();
  const taskId = useChatTaskId();
  const isShell = SHELL_LANGS.has(lang.trim().toLowerCase());
  // Single-line shell snippet → safe to seed + auto-run. Multi-line scripts →
  // seed the whole block but don't auto-fire (avoid running half a heredoc).
  const seedCmd = code.includes("\n") ? undefined : code.trim();
  return (
    <div className="overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)]/70">
      <div className="flex items-center justify-between border-b border-[var(--color-border)] px-3 py-1">
        <span className="font-mono text-[10.5px] text-[var(--color-faint)]">
          {lang || "code"}
        </span>
        <div className="flex items-center gap-1.5">
          {isShell && code.trim() && (
            <button
              type="button"
              onClick={() => spawnPane("terminal", { cwd: cwd ?? undefined, cmd: seedCmd, ...taskSpawnContext(taskId) })}
              title={seedCmd ? "run in a new terminal pane" : "open a terminal here (multi-line — run it yourself)"}
              className="flex items-center gap-1 rounded px-1 py-0.5 text-[10.5px] text-[var(--color-muted)] transition-colors hover:bg-[var(--color-panel-2)] hover:text-[var(--color-accent)]"
            >
              <Terminal size={11} />
              run in terminal
            </button>
          )}
          <CopyButton text={code} size={12} title="copy code" />
        </div>
      </div>
      <pre className="overflow-x-auto px-3 py-2.5 font-mono text-[12.5px] leading-relaxed text-[var(--color-text)]">
        <code>{code}</code>
      </pre>
    </div>
  );
});

/** Render the non-code body: split into block-level lines (headings / lists /
 *  paragraphs), each with inline formatting. The whole line-split + per-line
 *  regex parse is memoized on [text, onOpenUrl] and the component is React.memo'd,
 *  so an unchanged old message never re-parses its markdown when the parent
 *  re-renders (e.g. while a LATER message streams or the 1Hz clock ticks). */
const MarkdownBlocks = memo(function MarkdownBlocks({
  text,
  onOpenUrl,
}: {
  text: string;
  onOpenUrl?: (url: string) => void;
}) {
  const out = useMemo<React.ReactNode[]>(() => {
    if (!text.trim()) return [];
    const lines = text.split("\n");
    const nodes: React.ReactNode[] = [];
    let listBuf: { ordered: boolean; items: string[] } | null = null;
    let key = 0;

    const flushList = () => {
      if (!listBuf) return;
      const { ordered, items } = listBuf;
      const cls = "my-0.5 flex flex-col gap-1 pl-1 ";
      nodes.push(
        ordered ? (
          <ol key={`l${key++}`} className={cls}>
            {items.map((it, j) => (
              <li key={j} className="flex gap-2">
                <span className="select-none text-[var(--color-faint)]">{j + 1}.</span>
                <span className="flex-1">
                  <Inline text={it} onOpenUrl={onOpenUrl} />
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <ul key={`l${key++}`} className={cls}>
            {items.map((it, j) => (
              <li key={j} className="flex gap-2">
                <span className="select-none text-[var(--color-accent)]">•</span>
                <span className="flex-1">
                  <Inline text={it} onOpenUrl={onOpenUrl} />
                </span>
              </li>
            ))}
          </ul>
        ),
      );
      listBuf = null;
    };

    for (const raw of lines) {
      const line = raw;
      // headings
      const h = line.match(/^(#{1,4})\s+(.*)$/);
      if (h) {
        flushList();
        const level = h[1].length;
        const size =
          level === 1
            ? "text-[17px]"
            : level === 2
              ? "text-[15.5px]"
              : "text-[14.5px]";
        nodes.push(
          <div
            key={`h${key++}`}
            className={`mt-1 font-sans font-semibold text-[var(--color-text)] ${size}`}
          >
            <Inline text={h[2]} onOpenUrl={onOpenUrl} />
          </div>,
        );
        continue;
      }
      // unordered list
      const ul = line.match(/^\s*[-*]\s+(.*)$/);
      if (ul) {
        if (!listBuf || listBuf.ordered) {
          flushList();
          listBuf = { ordered: false, items: [] };
        }
        listBuf.items.push(ul[1]);
        continue;
      }
      // ordered list
      const ol = line.match(/^\s*\d+\.\s+(.*)$/);
      if (ol) {
        if (!listBuf || !listBuf.ordered) {
          flushList();
          listBuf = { ordered: true, items: [] };
        }
        listBuf.items.push(ol[1]);
        continue;
      }
      // blank line → paragraph break
      if (!line.trim()) {
        flushList();
        continue;
      }
      // plain paragraph line
      flushList();
      nodes.push(
        <p key={`p${key++}`} className="whitespace-pre-wrap break-words">
          <Inline text={line} onOpenUrl={onOpenUrl} />
        </p>,
      );
    }
    flushList();
    return nodes;
  }, [text, onOpenUrl]);

  if (out.length === 0) return null;
  return <>{out}</>;
});

/** Inline span formatting: `code`, **bold**, *italic* / _italic_, [text](url).
 *  Single-pass tokenizer — partial markers (e.g. a lone trailing `**` during
 *  streaming) just render literally, never throw. */
const Inline = memo(function Inline({
  text,
  onOpenUrl,
}: {
  text: string;
  onOpenUrl?: (url: string) => void;
}) {
  // deterministic cwd-anchored file open (context-provided), so a bare
  // `foo.ts` mention resolves against the session cwd + existence-checks before
  // opening — never a blind name search.
  const openFile = useChatFileOpener();
  const taskId = useChatTaskId();
  const nodes: React.ReactNode[] = [];
  let i = 0;
  let k = 0;
  let plain = "";
  const flush = () => {
    if (plain) {
      nodes.push(<span key={`s${k++}`}>{plain}</span>);
      plain = "";
    }
  };

  while (i < text.length) {
    const rest = text.slice(i);

    // inline code `…`
    if (text[i] === "`") {
      const end = text.indexOf("`", i + 1);
      if (end > i) {
        flush();
        const code = text.slice(i + 1, end);
        const fileish = isPaneFileTarget(code);
        nodes.push(
          fileish ? (
            <button
              key={`c${k++}`}
              type="button"
              onClick={() => openFile(code)}
              className="rounded bg-[var(--color-panel)] px-1 py-0.5 font-mono text-[0.85em] text-[var(--color-accent)] underline decoration-[var(--color-accent)]/30 underline-offset-2 hover:decoration-[var(--color-accent)]"
              title="open in pane"
            >
              {code}
            </button>
          ) : (
            <code
              key={`c${k++}`}
              className="rounded bg-[var(--color-panel)] px-1 py-0.5 font-mono text-[0.85em] text-[var(--color-text)]"
            >
              {code}
            </code>
          ),
        );
        i = end + 1;
        continue;
      }
    }

    // bold **…**
    if (rest.startsWith("**")) {
      const end = text.indexOf("**", i + 2);
      if (end > i + 1) {
        flush();
        nodes.push(
          <strong key={`b${k++}`} className="font-semibold text-[var(--color-text)]">
            <Inline text={text.slice(i + 2, end)} onOpenUrl={onOpenUrl} />
          </strong>,
        );
        i = end + 2;
        continue;
      }
    }

    // link [text](url)
    if (text[i] === "[") {
      const close = text.indexOf("]", i + 1);
      if (close > i && text[close + 1] === "(") {
        const paren = text.indexOf(")", close + 2);
        if (paren > close) {
          flush();
          const label = text.slice(i + 1, close);
          const url = text.slice(close + 2, paren);
          const http = isHttpPaneTarget(url);
          const fileish = isPaneFileTarget(url);
          nodes.push(
            <a
              key={`a${k++}`}
              href={url}
              target={http ? "_blank" : undefined}
              rel="noreferrer"
              onClick={(e) => {
                if (http) {
                  e.preventDefault();
                  if (onOpenUrl) onOpenUrl(url);
                  else openUrlInPane(url, undefined, taskSpawnContext(taskId));
                  return;
                }
                if (fileish) {
                  e.preventDefault();
                  openFile(url);
                }
              }}
              className="text-[var(--color-accent)] underline decoration-[var(--color-accent)]/40 underline-offset-2 hover:decoration-[var(--color-accent)]"
            >
              {label}
            </a>,
          );
          // For real http(s) links, add a small inline "open in browser pane"
          // affordance — a click spawns a native browser pane (don't auto-open).
          if (http) {
            nodes.push(
              <button
                key={`au${k++}`}
                type="button"
                onClick={() => spawnPane("browser", { url, ...taskSpawnContext(taskId) })}
                title="open in a browser pane"
                className="ml-0.5 inline-flex translate-y-[1px] items-center rounded p-0.5 align-baseline text-[var(--color-faint)] transition-colors hover:bg-[var(--color-panel-2)] hover:text-[var(--color-accent)]"
              >
                <Globe size={11} />
              </button>,
            );
          }
          i = paren + 1;
          continue;
        }
      }
    }

    // italic *…* or _…_  (avoid eating ** — handled above)
    if ((text[i] === "*" && text[i + 1] !== "*") || text[i] === "_") {
      const marker = text[i];
      const end = text.indexOf(marker, i + 1);
      if (end > i + 1) {
        flush();
        nodes.push(
          <em key={`i${k++}`} className="italic">
            {text.slice(i + 1, end)}
          </em>,
        );
        i = end + 1;
        continue;
      }
    }

    plain += text[i];
    i += 1;
  }
  flush();
  return <>{nodes}</>;
});
