import { homeDir, readTextFile } from "./fs";

export interface TrafficSourceRow {
  source: string;
  pageviews: number;
  uniques: number;
  pageviews_24h: number;
  uniques_24h: number;
  latest_visit: string | null;
}

export interface TrafficContentRow {
  content: string;
  pageviews: number;
  uniques: number;
  latest_visit: string | null;
}

export interface SeoSlugRow {
  slug: string;
  pageviews: number;
  uniques: number;
  pageviews_24h: number;
  uniques_24h: number;
  latest_visit: string | null;
}

export interface ChannelPolicy {
  enabled?: boolean;
  status?: string;
  mode?: string;
  max_posts_per_day?: number;
  minimum_spacing_hours?: number;
  schedule_myt?: string[];
  state?: {
    postsToday?: number;
    totalPosts?: number;
    updatedAt?: string | null;
    latestPost?: {
      postedAt?: string;
      url?: string;
      id?: string;
      utmContent?: string;
      wave?: number;
    } | null;
  };
  latest?: {
    date?: string;
    status?: string;
    title?: string | null;
    keyword?: string | null;
    url?: string | null;
    publishedWordCount?: number | null;
    indexNow?: { ok?: boolean; status?: number } | null;
  } | null;
}

export interface AiosAnalyticsReport {
  generatedAt: string;
  targetUniques: number;
  landing_pageviews_24h: number;
  landing_uniques_24h: number;
  campaign_pageviews_24h: number;
  campaign_uniques_24h: number;
  campaign_pageviews_total: number;
  campaign_uniques_total: number;
  latest_campaign_visit: string | null;
  seo_pageviews_24h: number;
  seo_uniques_24h: number;
  seo_pageviews_total: number;
  seo_uniques_total: number;
  latest_seo_visit: string | null;
  byContent: TrafficContentRow[];
  bySource: TrafficSourceRow[];
  seoBySlug: SeoSlugRow[];
  seoReferrers: Array<TrafficSourceRow & { referrer: string }>;
  channels?: {
    policyUpdatedAt?: string | null;
    threads?: ChannelPolicy;
    linkedin?: ChannelPolicy;
    x?: ChannelPolicy;
    seo?: ChannelPolicy;
  };
  lastDiscordPost?: string | null;
}

export async function loadAiosAnalytics(): Promise<AiosAnalyticsReport | null> {
  try {
    const home = await homeDir();
    const file = `${home}/.aios/state/audience-engine/landing-traffic-monitor.json`;
    const raw = await readTextFile(file);
    return JSON.parse(raw) as AiosAnalyticsReport;
  } catch {
    try {
      const res = await fetch("/__aios/analytics", { cache: "no-store" });
      if (!res.ok) return null;
      return (await res.json()) as AiosAnalyticsReport;
    } catch {
      return null;
    }
  }
}
