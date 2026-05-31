/** User-side project store — layered on top of the auto-scanned `list_projects`
 *  results so the user can CRUD projects from Settings:
 *   - ADD a custom project (path the scanner didn't find / outside ~/Repo)
 *   - HIDE a scanned project from the palette + dashboard
 *   - OVERRIDE a scanned project's display name and/or primary run command
 *  Persisted in localStorage; the App merges scanned + this store and re-merges
 *  on change (mirrors lib/sidebar's subscribe pattern). */
import type { ProjectInfo, RunCommand } from "./run";

const KEY = "aios.projects";
const EVENT = "aios:projects";

export interface ProjectsStore {
  /** User-added projects (not discovered by the scanner). */
  custom: ProjectInfo[];
  /** Roots hidden from the scanned list. */
  hidden: string[];
  /** root → { name?, cmd? } display/run overrides for scanned projects. */
  overrides: Record<string, { name?: string; cmd?: string }>;
}

const empty = (): ProjectsStore => ({ custom: [], hidden: [], overrides: {} });

export function loadProjectsStore(): ProjectsStore {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return empty();
    const p = JSON.parse(raw) as Partial<ProjectsStore>;
    return {
      custom: Array.isArray(p.custom) ? p.custom : [],
      hidden: Array.isArray(p.hidden) ? p.hidden : [],
      overrides: p.overrides && typeof p.overrides === "object" ? p.overrides : {},
    };
  } catch {
    return empty();
  }
}

function save(s: ProjectsStore) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* quota / disabled — non-fatal */
  }
  window.dispatchEvent(new Event(EVENT));
}

/** Subscribe to store changes (returns an unsubscribe). */
export function subscribeProjects(cb: () => void): () => void {
  const h = () => cb();
  window.addEventListener(EVENT, h);
  window.addEventListener("storage", h);
  return () => {
    window.removeEventListener(EVENT, h);
    window.removeEventListener("storage", h);
  };
}

/** Merge scanned projects with the store: drop hidden, apply name/cmd overrides,
 *  then append custom projects. Deduped by root (scanned wins over custom). */
export function mergeProjects(scanned: ProjectInfo[], store: ProjectsStore): ProjectInfo[] {
  const out: ProjectInfo[] = [];
  const seen = new Set<string>();
  for (const p of scanned) {
    if (store.hidden.includes(p.root)) continue;
    const ov = store.overrides[p.root];
    const proj: ProjectInfo = ov
      ? {
          ...p,
          name: ov.name?.trim() || p.name,
          commands: ov.cmd?.trim()
            ? [{ label: ov.cmd.trim(), cmd: ov.cmd.trim() }, ...p.commands]
            : p.commands,
        }
      : p;
    out.push(proj);
    seen.add(p.root);
  }
  for (const c of store.custom) {
    if (!seen.has(c.root)) {
      out.push(c);
      seen.add(c.root);
    }
  }
  return out;
}

const normRoot = (r: string) => r.trim().replace(/\/+$/, "");

/** Add (or replace) a custom project. */
export function addCustomProject(p: { name: string; root: string; cmd?: string }) {
  const root = normRoot(p.root);
  if (!root) return;
  const s = loadProjectsStore();
  s.custom = s.custom.filter((x) => x.root !== root);
  s.hidden = s.hidden.filter((r) => r !== root);
  const commands: RunCommand[] = p.cmd?.trim() ? [{ label: p.cmd.trim(), cmd: p.cmd.trim() }] : [];
  s.custom.push({
    name: p.name.trim() || root.split("/").pop() || root,
    root,
    kind: "unknown",
    commands,
    // stamp "now" so a freshly-added project sorts to the top of "recent".
    mtime: Math.floor(Date.now() / 1000),
  });
  save(s);
}

export function removeCustomProject(root: string) {
  const s = loadProjectsStore();
  s.custom = s.custom.filter((x) => x.root !== root);
  delete s.overrides[root];
  save(s);
}

export function setHidden(root: string, hidden: boolean) {
  const s = loadProjectsStore();
  s.hidden = s.hidden.filter((r) => r !== root);
  if (hidden) s.hidden.push(root);
  save(s);
}

export function setOverride(root: string, ov: { name?: string; cmd?: string }) {
  const s = loadProjectsStore();
  const cur = s.overrides[root] ?? {};
  const next = { ...cur, ...ov };
  // drop empties so an override that's been cleared disappears
  if (!next.name?.trim()) delete next.name;
  if (!next.cmd?.trim()) delete next.cmd;
  if (!next.name && !next.cmd) delete s.overrides[root];
  else s.overrides[root] = next;
  save(s);
}

export function isCustom(root: string, s = loadProjectsStore()): boolean {
  return s.custom.some((x) => x.root === root);
}
