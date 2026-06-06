/**
 * SidebarUsage — the narrow-sidebar rendering of the user's live usage for
 * claude (5h/7d rate-limit windows from the statusline) and codex (ChatGPT-sub
 * primary/secondary windows from ~/.codex).
 *
 * This is now a thin alias of the shared `UsageGlance` (components/dashboard) so
 * the sidebar and the idle home draw the bars from ONE source — no duplicated
 * markup, no drift. See UsageGlance for the data paths + color thresholds.
 */
export { UsageGlance as SidebarUsage } from "./dashboard/UsageGlance";
