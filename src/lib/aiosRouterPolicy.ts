export type AiosProvider = "claude" | "codex";

/** Pure provider policy. A fresh zero is authoritative evidence of a reset and
 * therefore supersedes a hard-limit observation from the previous window. */
export function decideAiosProvider(input: {
  claudeFiveHourPct: number | null;
  claudeHardLimited: boolean;
  resetWindowAdvanced?: boolean;
}): AiosProvider {
  if (input.claudeFiveHourPct === 0 && input.resetWindowAdvanced) return "claude";
  if (input.claudeHardLimited) return "codex";
  if (input.claudeFiveHourPct != null && input.claudeFiveHourPct >= 100) return "codex";
  return "claude";
}
