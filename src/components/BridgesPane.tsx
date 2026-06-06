/** Channels — the AIOS dispatch center. Every messaging channel AIOS speaks
 *  through, in one hub: which are connected + alive, and what's flowing through
 *  them. WhatsApp is the live, fully-detected proof (status + stats + an
 *  expandable conversation feed); the rest are connectors on the way, shown in
 *  the same visual language with a clear status + a "connect" affordance.
 *
 *  (File + export kept as BridgesPane — the nav relabel to "channels" happens in
 *  App.tsx. This is purely the reframed UI.) */
import { useCallback, useEffect, useRef, useState } from "react";

import {
  Activity,
  ArrowDownLeft,
  ArrowUpRight,
  AtSign,
  Camera,
  CheckCircle2,
  ChevronRight,
  Copy,
  Hash,
  Link2,
  Loader2,
  Mail,
  MessageCircle,
  MessageSquare,
  MessageSquareDot,
  Plug,
  Radio,
  RefreshCw,
  Send,
  Zap,
} from "lucide-react";

import {
  bridgeActivity,
  listBridges,
  pairPersonalWa,
  type Channel,
  type BridgeMessage,
  type Bridges,
} from "../lib/bridges";
import { type NotificationLevel } from "../lib/notifications";
import { reportDiag } from "../lib/diag";

/** Brand-ish icon per channel id (falls back to a generic plug). lucide only. */
function channelIcon(id: string, size = 13, className = "") {
  const cls = className || "text-[var(--color-text-2)]";
  switch (id) {
    case "whatsapp":
      return <MessageCircle size={size} className={className || "text-[var(--color-success)]"} />;
    case "instagram":
      return <Camera size={size} className={cls} />;
    case "threads":
      return <AtSign size={size} className={cls} />;
    case "gchat":
      return <MessageSquare size={size} className={cls} />;
    case "x":
      return <Hash size={size} className={cls} />;
    case "telegram":
      return <Send size={size} className={cls} />;
    case "gmail":
      return <Mail size={size} className={cls} />;
    case "imessage":
      return <MessageSquareDot size={size} className={cls} />;
    default:
      return <Plug size={size} className={cls} />;
  }
}

/** Maps a channel's status to a plain-language dot + label + colour — no jargon.
 *  connected → green "on", disconnected → amber "off", soon → grey "coming soon". */
function statusView(c: Channel): { dot: string; label: string; color: string } {
  if (c.status === "connected") {
    return {
      // green dot — pulses live (status-dot--active is the only green class).
      dot: "status-dot--active",
      label: "on",
      color: "text-[var(--color-success)]",
    };
  }
  if (c.status === "disconnected") {
    return {
      dot: "status-dot--idle",
      label: "off",
      color: "text-[var(--color-warning)]",
    };
  }
  // soon
  return {
    dot: "status-dot--cold",
    label: "coming soon",
    color: "text-[var(--color-muted)]",
  };
}

/** Turns a compact duration token ("10d 14h", "5m", "14h") into plain words —
 *  takes the largest unit only, e.g. "10 days", "5 min", "14 hours". */
function humanizeDuration(s: string | null): string | null {
  if (!s) return null;
  const m = s.trim().match(/(\d+)\s*(s|m|h|d|w)/i);
  if (!m) return s.trim();
  const n = Number(m[1]);
  switch (m[2].toLowerCase()) {
    case "s":
      return "moments";
    case "m":
      return `${n} min`;
    case "h":
      return `${n} ${n === 1 ? "hour" : "hours"}`;
    case "d":
      return `${n} ${n === 1 ? "day" : "days"}`;
    default:
      return `${n} ${n === 1 ? "week" : "weeks"}`;
  }
}

/** A one-line, layman-readable health summary for a connected channel, e.g.
 *  "working normally · on for 10 days · last message 5 min ago". */
function healthSentence(c: Channel): string {
  const parts = ["working normally"];
  const up = humanizeDuration(c.uptime);
  if (up && up !== "moments") parts.push(`on for ${up}`);
  const ago = humanizeDuration(c.lastActivityAgo);
  if (ago) parts.push(ago === "moments" ? "active just now" : `last message ${ago} ago`);
  return parts.join(" · ");
}

export function BridgesPane() {
  const [data, setData] = useState<Bridges | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // lightweight self-contained toast (connect button is an honest no-op).
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = useCallback((msg: string, _level: NotificationLevel = "info", _body?: string) => {
    // Local toast only. These are ephemeral UI acks (e.g. "connect is a no-op") —
    // mirroring them into the bell was pure noise, so it's dropped.
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2500);
  }, []);
  useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
  }, []);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      setData(await listBridges());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    // channels should feel live — poll fast.
    const t = setInterval(refresh, 10_000);
    return () => clearInterval(t);
  }, [refresh]);

  // personal-WhatsApp pairing (the wwebjs session the "personal" send-channel uses)
  const [pairing, setPairing] = useState(false);
  const [pairCode, setPairCode] = useState<string | null>(null);
  const [pairErr, setPairErr] = useState<string | null>(null);
  const pairPersonal = useCallback(async () => {
    setPairing(true);
    setPairErr(null);
    setPairCode(null);
    try {
      const res = await pairPersonalWa();
      if (res.ok && res.code) setPairCode(res.code);
      else setPairErr(res.error || "couldn't get a pairing code");
    } catch (e) {
      setPairErr(e instanceof Error ? e.message : String(e));
    } finally {
      setPairing(false);
    }
  }, []);

  const channels = data?.bridges ?? [];
  const connectedCount = channels.filter((c) => c.status === "connected").length;

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--color-pane)]">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-[var(--color-border)] px-3">
        <div className="flex items-center gap-2">
          <Radio size={14} className="text-[var(--color-accent)]" />
          <span className="text-[13px] font-medium text-[var(--color-text)]">channels</span>
          {channels.length > 0 && (
            <span className="text-[11px] text-[var(--color-muted)]">
              {connectedCount} connected
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={pairPersonal}
            disabled={pairing}
            className="flex items-center gap-1 rounded-md border border-[var(--color-border)] px-1.5 py-0.5 text-[11px] text-[var(--color-text-2)] transition-colors hover:border-[var(--color-accent)]/50 hover:text-[var(--color-text)] disabled:opacity-50"
            title="pair your personal WhatsApp (wwebjs) — enables the 'personal' send channel"
          >
            {pairing ? <Loader2 size={11} className="animate-spin" /> : <Link2 size={11} />}
            pair personal
          </button>
          <button
            onClick={refresh}
            className="rounded p-1 text-[var(--color-muted)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
            title="Refresh"
          >
            <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
          </button>
        </div>
      </div>

      {/* personal-WA pairing banner */}
      {(pairing || pairCode || pairErr) && (
        <div className="shrink-0 border-b border-[var(--color-border)] bg-[var(--color-panel-2)]/40 px-3 py-2.5">
          {pairing && (
            <p className="flex items-center gap-1.5 text-[12px] text-[var(--color-muted)]">
              <Loader2 size={12} className="animate-spin" /> booting the wwebjs client + requesting a code… (can take ~30-50s)
            </p>
          )}
          {pairCode && (
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-[var(--color-muted)]">pairing code</span>
                <span className="font-mono text-[18px] font-semibold tracking-[0.2em] text-[var(--color-accent)]">{pairCode}</span>
                <button
                  onClick={() => navigator.clipboard?.writeText(pairCode).catch((e) => reportDiag("bridges.clipboard", e, { action: "pairCode" }))}
                  className="rounded p-1 text-[var(--color-muted)] hover:bg-[var(--color-bg)] hover:text-[var(--color-text)]"
                  title="copy"
                >
                  <Copy size={12} />
                </button>
              </div>
              <p className="text-[11px] leading-snug text-[var(--color-text-2)]">
                on your phone: WhatsApp → Settings → Linked Devices → Link a Device →{" "}
                <span className="text-[var(--color-text)]">Link with phone number</span> → enter this code. (it expires fast — re-pair if it lapses.)
              </p>
            </div>
          )}
          {pairErr && <p className="text-[12px] text-[var(--color-danger)]">{pairErr}</p>}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <p className="mb-3 text-[11px] leading-relaxed text-[var(--color-muted)]">
          all the apps AIOS can message people through. a{" "}
          <span className="text-[var(--color-success)]">green dot</span> means it's on and
          working — grey means it's not set up yet.
        </p>

        {error && <p className="text-[12px] text-[var(--color-danger)]">{error}</p>}

        {channels.length === 0 && !loading && !error && (
          <p className="text-[11px] text-[var(--color-muted)]/60">no channels detected.</p>
        )}

        <div className="flex flex-col gap-2.5">
          {channels.map((c) => (
            <ChannelCard key={c.id} channel={c} onConnect={showToast} />
          ))}
        </div>
      </div>

      {toast && (
        <div className="pointer-events-none absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-1.5 text-[11px] text-[var(--color-text)] shadow-lg">
          {toast}
        </div>
      )}
    </div>
  );
}

/** One channel card — same visual language for every channel. Connected ones
 *  show the stats row + an expandable activity feed; the rest show a clear
 *  status + a "connect" affordance. */
function ChannelCard({
  channel: c,
  onConnect,
}: {
  channel: Channel;
  onConnect: (msg: string) => void;
}) {
  const connected = c.status === "connected";
  const { dot, label, color } = statusView(c);

  // connected channels open their feed by default — those are worth watching;
  // the rest have nothing to expand.
  const [open, setOpen] = useState(connected);
  // the sysadmin meta (pid / launchd job / log file) stays hidden — a normal
  // person never needs it; power users can pop it open.
  const [showTech, setShowTech] = useState(false);

  return (
    <div
      className={`flex flex-col gap-2 rounded-lg border px-3 py-2.5 ${
        connected
          ? "border-[var(--color-border)] bg-[var(--color-panel-2)]/30"
          : "border-[var(--color-border)]/60 bg-[var(--color-panel-2)]/15"
      }`}
    >
      {/* header row: brand icon + name + type chip · status dot + label */}
      <div className="flex items-center gap-2.5">
        <span
          className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md ${
            connected ? "bg-[var(--color-bg)]" : "bg-[var(--color-bg)]/50"
          }`}
        >
          {channelIcon(c.id, 14, connected ? "" : "text-[var(--color-muted)]")}
        </span>
        <span className={`truncate text-[12px] font-medium ${connected ? "text-[var(--color-text)]" : "text-[var(--color-text-2)]"}`}>
          {c.name}
        </span>
        <span className="flex items-center rounded-full bg-[var(--color-bg)] px-2 py-0.5 text-[10px] text-[var(--color-text-2)]">
          {c.kind}
        </span>
        <span className="ml-auto flex items-center gap-1.5">
          <span className={`status-dot shrink-0 ${dot}`} />
          <span className={`text-[11px] ${color}`}>{label}</span>
        </span>
      </div>

      {connected ? (
        <>
          {/* plain-language health line — what a normal person actually wants to know */}
          <div className="flex items-start gap-1.5 text-[11.5px] leading-snug text-[var(--color-text-2)]">
            <CheckCircle2 size={13} className="mt-px shrink-0 text-[var(--color-success)]" />
            <span>{healthSentence(c)}</span>
          </div>

          {/* message counts in plain words */}
          <div className="flex items-center gap-1.5 text-[12px] text-[var(--color-text-2)]">
            <Activity size={12} className="text-[var(--color-accent)]" />
            <span>
              <span className="font-medium text-[var(--color-text)]">
                {(c.messagesTotal ?? 0).toLocaleString()}
              </span>{" "}
              messages sent
            </span>
            {c.today != null && (
              <span className="text-[var(--color-muted)]">
                · <span className="text-[var(--color-text-2)]">{c.today.toLocaleString()}</span> today
              </span>
            )}
          </div>

          {/* recent messages — expandable chat-style feed */}
          <button
            onClick={() => setOpen((v) => !v)}
            className="-mx-1 mt-0.5 flex items-center gap-1 rounded px-1 py-0.5 text-left text-[11px] text-[var(--color-muted)] hover:bg-[var(--color-panel-2)]/50 hover:text-[var(--color-text-2)]"
          >
            <ChevronRight
              size={11}
              className={`transition-transform ${open ? "rotate-90" : ""}`}
            />
            <MessageCircle size={11} />
            <span>recent messages</span>
          </button>

          {open && <ActivityFeed channelId={c.id} />}

          {/* sysadmin details — hidden by default; only the curious open it */}
          {(c.pid != null || c.launchd || c.logPath || c.lastActivity) && (
            <>
              <button
                onClick={() => setShowTech((v) => !v)}
                className="-mx-1 flex items-center gap-1 rounded px-1 py-0.5 text-left text-[10px] text-[var(--color-faint)] hover:bg-[var(--color-panel-2)]/50 hover:text-[var(--color-muted)]"
              >
                <ChevronRight
                  size={10}
                  className={`transition-transform ${showTech ? "rotate-90" : ""}`}
                />
                <span>technical details</span>
              </button>
              {showTech && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 pl-3 text-[10px] text-[var(--color-faint)]">
                  {c.pid != null && (
                    <span className="flex items-center gap-1">
                      <Zap size={9} />
                      <span className="font-mono">pid {c.pid}</span>
                    </span>
                  )}
                  {c.launchd && <span className="font-mono">{c.launchd}</span>}
                  {c.lastActivity && <span className="font-mono">last {c.lastActivity}</span>}
                  {c.logPath && <span className="truncate font-mono">{c.logPath}</span>}
                </div>
              )}
            </>
          )}
        </>
      ) : (
        <NotConnectedRow channel={c} onConnect={onConnect} />
      )}
    </div>
  );
}

/** The row shown for a not-yet-connected channel: a terse hint + an honest
 *  "connect" button (no-op for now — it just surfaces a "coming" toast). */
function NotConnectedRow({
  channel: c,
  onConnect,
}: {
  channel: Channel;
  onConnect: (msg: string) => void;
}) {
  const soon = c.status === "soon";
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[11px] text-[var(--color-muted)]/80">
        {soon ? "not ready yet — coming soon" : "currently off — press connect to turn it back on"}
      </span>
      <button
        onClick={() => onConnect("channel connectors coming — not wired yet")}
        className="flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-0.5 text-[11px] text-[var(--color-text-2)] hover:border-[var(--color-accent)]/50 hover:text-[var(--color-text)]"
        title="channel connectors coming soon"
      >
        <Plug size={11} />
        <span>connect</span>
      </button>
    </div>
  );
}

/** A scrollable, chat-style feed of the messages flowing through a channel.
 *  Newest at top. Polls every 10s while mounted (i.e. while expanded). */
function ActivityFeed({ channelId }: { channelId: string }) {
  const [messages, setMessages] = useState<BridgeMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await bridgeActivity(channelId, 25);
      setMessages(res.messages);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [channelId]);

  useEffect(() => {
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [load]);

  if (error) {
    return <p className="text-[11px] text-[var(--color-danger)]">{error}</p>;
  }
  if (messages == null) {
    return <p className="text-[11px] text-[var(--color-muted)]/60">loading…</p>;
  }
  if (messages.length === 0) {
    return <p className="text-[11px] text-[var(--color-muted)]/60">no recent messages.</p>;
  }

  return (
    <div className="flex max-h-64 flex-col gap-1.5 overflow-y-auto rounded-md border border-[var(--color-border)]/60 bg-[var(--color-bg)]/40 p-2">
      {messages.map((m, i) => (
        <MessageRow key={`${m.ts}-${i}`} msg={m} />
      ))}
    </div>
  );
}

/** One feed row. Outbound = accent-tinted, right-aligned, "→"/↗ marker.
 *  Inbound = panel-2 bubble, left-aligned, "←"/↙ marker. */
function MessageRow({ msg: m }: { msg: BridgeMessage }) {
  const out = m.direction === "out";
  const bubble = out
    ? "self-end bg-[var(--color-accent)]/12 border-[var(--color-accent)]/30"
    : "self-start bg-[var(--color-panel-2)]/60 border-[var(--color-border)]";
  const DirIcon = out ? ArrowUpRight : ArrowDownLeft;
  const dirColor = out ? "text-[var(--color-accent)]" : "text-[var(--color-info)]";

  return (
    <div className={`flex max-w-[88%] flex-col gap-0.5 rounded-md border px-2 py-1 ${bubble}`}>
      {/* meta line: direction marker · peer · timestamp + ago */}
      <div className="flex items-center gap-1.5 text-[10px]">
        <DirIcon size={10} className={`shrink-0 ${dirColor}`} />
        <span className={`truncate font-mono ${out ? "text-[var(--color-accent)]" : "text-[var(--color-text-2)]"}`}>
          {m.peer}
        </span>
        <span className="ml-auto shrink-0 font-mono text-[var(--color-faint)]">{m.ts}</span>
        {m.tsAgo && (
          <span className="shrink-0 font-mono text-[var(--color-faint)]">· {m.tsAgo} ago</span>
        )}
      </div>
      {/* message text */}
      {m.text && (
        <p className="whitespace-pre-wrap break-words text-[11px] leading-snug text-[var(--color-text)]">
          {m.text}
        </p>
      )}
    </div>
  );
}
