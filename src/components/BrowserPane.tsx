/** Browser pane — an in-app web view (iframe) with a chrome-style URL bar +
 *  back/forward/reload and an "open external" escape hatch. Note: some sites
 *  (google.com, etc.) block iframing via X-Frame-Options; those open external.
 *  A true embedded Tauri webview is the planned upgrade. */
import { useCallback, useRef, useState } from "react";

import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowLeft, ArrowRight, ExternalLink, RotateCw } from "lucide-react";

function normalizeUrl(input: string): string {
  const v = input.trim();
  if (!v) return "";
  if (/^https?:\/\//i.test(v)) return v;
  if (/^[\w-]+(\.[\w-]+)+/.test(v)) return `https://${v}`;
  return `https://www.google.com/search?q=${encodeURIComponent(v)}`;
}

export function BrowserPane() {
  const [stack, setStack] = useState<string[]>([]);
  const [idx, setIdx] = useState(-1);
  const [input, setInput] = useState("");
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const current = idx >= 0 ? stack[idx] : "";

  const navigate = useCallback(
    (raw: string) => {
      const url = normalizeUrl(raw);
      if (!url) return;
      setStack((prev) => {
        const next = prev.slice(0, idx + 1);
        next.push(url);
        return next;
      });
      setIdx((i) => i + 1);
      setInput(url);
    },
    [idx],
  );

  const back = () => {
    if (idx > 0) {
      setIdx(idx - 1);
      setInput(stack[idx - 1]);
    }
  };
  const fwd = () => {
    if (idx < stack.length - 1) {
      setIdx(idx + 1);
      setInput(stack[idx + 1]);
    }
  };
  const reload = () => {
    if (iframeRef.current && current) iframeRef.current.src = current;
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--color-pane)]">
      {/* chrome bar */}
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-[var(--color-border)] px-2">
        <button onClick={back} disabled={idx <= 0} className="rounded p-1 text-[var(--color-muted)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)] disabled:opacity-30">
          <ArrowLeft size={14} />
        </button>
        <button onClick={fwd} disabled={idx >= stack.length - 1} className="rounded p-1 text-[var(--color-muted)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)] disabled:opacity-30">
          <ArrowRight size={14} />
        </button>
        <button onClick={reload} disabled={!current} className="rounded p-1 text-[var(--color-muted)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)] disabled:opacity-30">
          <RotateCw size={13} />
        </button>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") navigate(input);
          }}
          placeholder="search or enter url"
          className="mx-1 h-6 flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] px-2.5 text-[12px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]/50"
        />
        {current && (
          <button onClick={() => openUrl(current).catch(() => {})} className="rounded p-1 text-[var(--color-muted)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]" title="Open in default browser">
            <ExternalLink size={13} />
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1">
        {current ? (
          <iframe
            ref={iframeRef}
            src={current}
            title="browser"
            className="h-full w-full border-0 bg-white"
            sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-[var(--color-muted)]">
            <p className="text-sm">type a url or search above</p>
            <div className="flex flex-wrap justify-center gap-1.5">
              {["github.com", "vercel.com", "neon.tech", "tailwindcss.com"].map((s) => (
                <button key={s} onClick={() => navigate(s)} className="rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] px-2 py-1 text-[11px] hover:border-[var(--color-accent)]/50">
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
