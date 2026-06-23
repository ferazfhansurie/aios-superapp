import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Activity,
  BarChart3,
  ExternalLink,
  RefreshCw,
  Search,
  Share2,
  TimerReset,
} from "lucide-react";

import { loadAiosAnalytics, type AiosAnalyticsReport, type ChannelPolicy } from "../lib/analytics";
import { reportDiag } from "../lib/diag";
import { useVisible } from "../lib/useVisible";
import { useSharedInterval } from "../lib/ticker";

function n(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function ago(value?: string | null): string {
  if (!value) return "none";
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return "unknown";
  const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function short(value?: string | null, max = 42): string {
  const text = String(value || "unknown");
  return text.length <= max ? text : `${text.slice(0, max - 1)}...`;
}

function pct(part: number, total: number): number {
  if (!total) return 0;
  return Math.max(0, Math.min(100, Math.round((part / total) * 100)));
}

export function AnalyticsPane({ active = true }: { active?: boolean }) {
  const { ref: rootRef, visible } = useVisible<HTMLDivElement>();
  const [report, setReport] = useState<AiosAnalyticsReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      setReport(await loadAiosAnalytics());
      setError(null);
    } catch (e) {
      setError(String(e));
      reportDiag("analytics.load", e, { action: "loadAiosAnalytics" });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!active || !visible) return;
    void load();
  }, [active, visible]);
  // Steady refresh on the shared 30s interval — only while active + visible.
  useSharedInterval(30_000, () => void load(), active && visible);

  const stale = useMemo(() => {
    if (!report?.generatedAt) return true;
    const ageMs = Date.now() - new Date(report.generatedAt).getTime();
    return !Number.isFinite(ageMs) || ageMs > 10 * 60_000;
  }, [report?.generatedAt]);

  const funnelProgress = pct(n(report?.campaign_uniques_total), n(report?.targetUniques));
  const topSource = report?.bySource?.[0];
  const topSeo = report?.seoBySlug?.[0];

  return (
    <div ref={rootRef} className="flex h-full min-h-0 flex-col bg-[var(--color-pane)]">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--color-border)] px-3">
        <BarChart3 size={14} className="text-[var(--color-accent)]" />
        <span className="text-[13px] font-medium text-[var(--color-text)]">analytics</span>
        <span className="text-[11px] text-[var(--color-muted)]">aios.adleticagency.com</span>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="ml-auto rounded p-1 text-[var(--color-muted)] transition-colors hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)] disabled:opacity-50"
          title="refresh analytics"
        >
          <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {error && (
          <div className="mb-3 rounded-md border border-[var(--color-danger)]/35 bg-[var(--color-danger)]/10 px-2.5 py-2 text-[11px] text-[var(--color-danger)]">
            analytics failed: {error}
          </div>
        )}

        {!report ? (
          <div className="flex h-full items-center justify-center text-[12px] text-[var(--color-faint)]">
            no analytics state yet
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2 text-[10px] text-[var(--color-muted)]">
              <span>updated {ago(report.generatedAt)}</span>
              {stale && (
                <span className="rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[var(--color-muted)]">
                  stale
                </span>
              )}
              <span className="ml-auto">last lead signal {ago(report.latest_campaign_visit)}</span>
            </div>

            <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
              <Metric label="funnel uniques" value={`${n(report.campaign_uniques_total)}/${n(report.targetUniques)}`} sub={`${funnelProgress}% target`} />
              <Metric label="funnel 24h" value={n(report.campaign_uniques_24h)} sub={`${n(report.campaign_pageviews_24h)} pageviews`} />
              <Metric label="seo uniques" value={n(report.seo_uniques_total)} sub={`${n(report.seo_pageviews_total)} pageviews`} />
              <Metric label="seo 24h" value={n(report.seo_uniques_24h)} sub={`${n(report.seo_pageviews_24h)} pageviews`} />
            </div>

            <section className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
              <div className="flex flex-col gap-2">
                <SectionTitle icon={<Share2 size={12} />} label="source split" detail={topSource ? `leader: ${topSource.source}` : "waiting"} />
                {(report.bySource || []).length ? (
                  report.bySource.map((row) => (
                    <BarRow
                      key={row.source}
                      label={row.source}
                      value={n(row.uniques)}
                      total={Math.max(1, n(report.campaign_uniques_total))}
                      sub={`${n(row.uniques_24h)}u 24h · ${n(row.pageviews)} pv · ${ago(row.latest_visit)}`}
                    />
                  ))
                ) : (
                  <EmptyLine text="no attributed funnel traffic yet" />
                )}
              </div>

              <div className="flex flex-col gap-2">
                <SectionTitle icon={<Activity size={12} />} label="content winners" detail="utm_content" />
                {(report.byContent || []).length ? (
                  report.byContent.map((row) => (
                    <CompactRow
                      key={row.content}
                      label={row.content}
                      value={`${n(row.uniques)}u`}
                      sub={`${n(row.pageviews)} pv · ${ago(row.latest_visit)}`}
                    />
                  ))
                ) : (
                  <EmptyLine text="no content winner yet" />
                )}
              </div>
            </section>

            <section className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
              <div className="flex flex-col gap-2">
                <SectionTitle icon={<Search size={12} />} label="seo pages" detail={topSeo ? short(topSeo.slug, 28) : "writing traffic"} />
                {(report.seoBySlug || []).length ? (
                  report.seoBySlug.map((row) => (
                    <BarRow
                      key={row.slug}
                      label={row.slug}
                      value={n(row.uniques)}
                      total={Math.max(1, n(report.seo_uniques_total))}
                      sub={`${n(row.uniques_24h)}u 24h · ${n(row.pageviews)} pv · ${ago(row.latest_visit)}`}
                    />
                  ))
                ) : (
                  <EmptyLine text="no writing-page visits yet" />
                )}
              </div>

              <div className="flex flex-col gap-2">
                <SectionTitle icon={<ExternalLink size={12} />} label="seo referrers" detail="source / referrer" />
                {(report.seoReferrers || []).length ? (
                  report.seoReferrers.map((row) => (
                    <CompactRow
                      key={row.referrer}
                      label={short(row.referrer, 44)}
                      value={`${n(row.uniques)}u`}
                      sub={`${n(row.uniques_24h)}u 24h · ${n(row.pageviews)} pv`}
                    />
                  ))
                ) : (
                  <EmptyLine text="no seo referrer yet" />
                )}
              </div>
            </section>

            <section className="flex flex-col gap-2">
              <SectionTitle icon={<TimerReset size={12} />} label="publishing loops" detail="seo + social" />
              <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
                <ChannelCard name="threads" channel={report.channels?.threads} />
                <ChannelCard name="linkedin" channel={report.channels?.linkedin} />
                <ChannelCard name="x" channel={report.channels?.x} />
                <ChannelCard name="seo" channel={report.channels?.seo} />
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}

function Metric({ label, value, sub }: { label: string; value: number | string; sub: string }) {
  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)]/35 px-2.5 py-2">
      <div className="font-mono text-[18px] font-semibold leading-none text-[var(--color-text)]">{value}</div>
      <div className="mt-1 text-[9px] uppercase tracking-wide text-[var(--color-faint)]">{label}</div>
      <div className="mt-1 text-[10px] text-[var(--color-muted)]">{sub}</div>
    </div>
  );
}

function SectionTitle({ icon, label, detail }: { icon: ReactNode; label: string; detail: string }) {
  return (
    <div className="flex items-center gap-1.5 px-0.5">
      <span className="text-[var(--color-accent)]">{icon}</span>
      <span className="text-[10px] font-medium uppercase tracking-wide text-[var(--color-muted)]">{label}</span>
      <span className="ml-auto text-[9px] text-[var(--color-faint)]">{detail}</span>
    </div>
  );
}

function BarRow({ label, value, total, sub }: { label: string; value: number; total: number; sub: string }) {
  const width = pct(value, total);
  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)]/30 px-2.5 py-2">
      <div className="flex items-baseline gap-2">
        <span className="truncate text-[12px] font-medium text-[var(--color-text)]">{label}</span>
        <span className="ml-auto font-mono text-[12px] text-[var(--color-text)]">{value}</span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-[var(--color-panel-2)]">
        <div className="h-full rounded-full bg-[var(--color-accent)]" style={{ width: `${width}%` }} />
      </div>
      <div className="mt-1 text-[10px] text-[var(--color-faint)]">{sub}</div>
    </div>
  );
}

function CompactRow({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)]/30 px-2.5 py-2">
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12px] font-medium text-[var(--color-text)]">{label}</div>
        <div className="mt-0.5 text-[10px] text-[var(--color-faint)]">{sub}</div>
      </div>
      <span className="font-mono text-[12px] text-[var(--color-text)]">{value}</span>
    </div>
  );
}

function ChannelCard({ name, channel }: { name: string; channel?: ChannelPolicy }) {
  const enabled = channel?.enabled !== false && channel?.status !== "missing_credentials";
  const postsToday = name === "seo" ? (channel?.latest?.date ? 1 : 0) : n(channel?.state?.postsToday);
  const schedule = channel?.schedule_myt?.join(" · ") || "not scheduled";
  const latest = name === "seo" ? channel?.latest?.url : channel?.state?.latestPost?.url || channel?.state?.latestPost?.id;
  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)]/30 px-2.5 py-2">
      <div className="flex items-center gap-2">
        <span className={`h-1.5 w-1.5 rounded-full ${enabled ? "bg-[var(--color-success)]" : "bg-[var(--color-danger)]"}`} />
        <span className="text-[12px] font-medium text-[var(--color-text)]">{name}</span>
        <span className="ml-auto text-[9px] text-[var(--color-faint)]">{channel?.status || "unknown"}</span>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-1.5">
        <Tiny label="today" value={postsToday} />
        <Tiny label="cap" value={channel?.max_posts_per_day ?? "-"} />
      </div>
      <div className="mt-2 truncate text-[10px] text-[var(--color-muted)]">{schedule}</div>
      <div className="mt-1 truncate text-[10px] text-[var(--color-faint)]">
        {name === "seo" && channel?.latest?.title ? short(channel.latest.title, 48) : latest ? short(latest, 48) : "no post receipt yet"}
      </div>
    </div>
  );
}

function Tiny({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded border border-[var(--color-border)]/70 px-1.5 py-1">
      <div className="font-mono text-[12px] leading-none text-[var(--color-text)]">{value}</div>
      <div className="mt-1 text-[8px] uppercase tracking-wide text-[var(--color-faint)]">{label}</div>
    </div>
  );
}

function EmptyLine({ text }: { text: string }) {
  return <div className="px-1 py-2 text-[11px] text-[var(--color-faint)]">{text}</div>;
}
