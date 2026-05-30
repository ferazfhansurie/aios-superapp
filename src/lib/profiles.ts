/** Browser profiles = isolated cookie partitions (like Chrome profiles). Each
 *  named profile is its own persistent WKWebsiteDataStore on the Rust side
 *  (see `browser.rs::profile_store_id`), so several Google accounts (personal /
 *  noobx29 / fathopes work) can be logged in at the same time — each pane opens
 *  in its own jar and does a fresh first-login instead of Google's stricter
 *  "add account" flow that throws "this browser or app may not be secure".
 *
 *  "default" is the shared, unpartitioned store (the original login). The list
 *  below is just the set of profile NAMES the user has created, persisted so the
 *  switcher remembers them. */

const KEY = "aios.browser.profiles";
export const DEFAULT_PROFILE = "default";

export function loadProfiles(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : null;
    const names = Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
    return [DEFAULT_PROFILE, ...names.filter((n) => n !== DEFAULT_PROFILE)];
  } catch {
    return [DEFAULT_PROFILE];
  }
}

/** Adds a profile name (no-op if it already exists or is the default), returns
 *  the cleaned name actually stored (or null if rejected). */
export function addProfile(name: string): string | null {
  const clean = name.trim().toLowerCase().slice(0, 24);
  if (!clean || clean === DEFAULT_PROFILE) return null;
  const existing = loadProfiles();
  if (existing.includes(clean)) return clean;
  try {
    const named = existing.filter((n) => n !== DEFAULT_PROFILE);
    localStorage.setItem(KEY, JSON.stringify([...named, clean]));
  } catch {
    /* storage full / disabled — name still usable this session */
  }
  return clean;
}
