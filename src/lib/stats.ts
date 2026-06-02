/** Wrapper over the `usage_extras` Rust command — long-horizon usage stats
 *  (activity heatmap, streaks, totals) derived from ~/.claude/stats-cache.json.
 *  Distinct from `usage_stats`, which is the live 5h/7d rate-limit feed. */
import { invoke } from "./tauri";

export interface HeatmapDay {
  date: string; // YYYY-MM-DD
  count: number;
}

export interface UsageExtras {
  totalSessions: number | null;
  totalMessages: number | null;
  favoriteModel: string | null;
  tokensTotal: number | null;
  firstSessionDate: string | null;
  currentStreak: number;
  longestStreak: number;
  active7d: number;
  active30d: number;
  heatmap: HeatmapDay[];
}

export async function usageExtras(): Promise<UsageExtras> {
  return invoke<UsageExtras>("usage_extras");
}
