# Codex-Calibrated AIOS Shell Design

## Decision

AIOS adopts Codex's extracted dark semantic system as its visual baseline while retaining AIOS-owned interaction, runtime accent switching, panes, and task workspace. This is a calibration, not a private-internals copy.

## Goals

- make chat, panes, controls, diffs, and overlays read as one calm macOS-native workstation;
- use the verified Codex dark layers, text hierarchy, border opacity, spacing rhythm, and radii;
- preserve AIOS's user-selectable accent and semantic color roles;
- keep desktop performance unchanged: tokens are CSS variables, not per-pane React state.

## Semantic tokens

The global foundation maps to the following resolved dark values:

| Role | Value |
| --- | --- |
| app ground | `#000` |
| workspace surface | `#181818` |
| opaque surface/card | `#212121` |
| elevated overlay | `#212121f5` |
| hover/active | `#ffffff14` / `#ffffff1f` |
| primary/secondary/muted text | `#fff` / `#ffffffb3` / `#ffffff80` |
| border/light/heavy | `#ffffff14` / `#ffffff0a` / `#ffffff29` |
| focus | `#339cffb3` |
| warning accent | `#fb6a22` |
| success/danger | `#04b84c` / `#fa423e` |

Existing `--color-accent*` remains runtime configurable. The default orange becomes Codex's verified `#fb6a22`; warning/full-access always uses that semantic orange even when a user chooses a different personal accent.

The implementation bridge is explicit, so current component classes keep working during migration:

| Existing AIOS token | Dark value / role |
| --- | --- |
| `--color-bg` | `#000` app/rail ground |
| `--color-pane` | `#181818` main pane interior |
| `--color-panel` | `#181818` workspace/chrome surface |
| `--color-panel-2` | `#212121` opaque card/composer surface |
| `--color-text`, `--color-text-2`, `--color-muted`, `--color-faint` | `#fff`, `#ffffffb3`, `#ffffff80`, `#ffffff80` with component opacity only where a fifth tier is needed |
| `--color-border`, `--color-border-light`, `--color-border-strong` | `#ffffff14`, `#ffffff0a`, `#ffffff29` |
| `--color-focus` | immutable `#339cffb3`, never replaced by personal accent |

`--color-accent*` remains a *personalization* ramp. New immutable semantic roles are `--color-warning-accent: #fb6a22`, `--color-warning-fg: #000`, `--color-warning-soft`, `--color-success-accent`, `--color-danger-accent`, `--color-diff-add`, and `--color-diff-delete`. Full-access/permission chips use warning tokens; generic warnings retain their current role until each surface is deliberately migrated. This prevents a custom blue/purple/green accent from turning a security-affecting permission state into a personal-color state.

## Geometry and type

- base spacing is 4px;
- row controls use 10px radius, cards 15px, bubbles 20px, composer 30px, chips full-pill;
- chat body is 16px with 1.5 line height; dense shell chrome remains 11–13px;
- user messages are right-aligned elevated bubbles; assistant prose remains unbubbled;
- tool rows are compact elevated rows, never big cards by default.

## Scope and rollout

1. create a stable semantic token bridge in `App.css`; expose a separate immutable focus/warning/diff family beside the mutable personal accent family;
2. retune shared primitives (pane chrome, buttons, menus, popovers, fields, chips) to use roles rather than literal opacity classes;
3. retune ChatPane first: transcript, composer, permissions, model/effort controls, tool rows, task summary, and conversation rail;
4. retune terminal/files/browser/review surfaces through the same primitives;
5. add visual regression/source contracts and inspect the installed app at desktop and narrow pane widths.

## Theme boundaries and contrast

- dark mode gets the extracted values above. Light mode gets paired semantic roles using the existing AIOS light overrides; it does not receive dark literal values copied into individual components.
- the immutable light semantic table is:

| Token | Light value |
| --- | --- |
| `--color-focus` | `#0285ffb3` |
| `--color-warning-accent` / `--color-warning-fg` / `--color-warning-soft` | `#e25507` / `#000` / `#ffe7d9` |
| `--color-success-accent` | `#00a240` |
| `--color-danger-accent` | `#e02e2a` |
| `--color-diff-add` / `--color-diff-delete` | `#00a2401f` / `#e02e2a1f` |

- xterm remains intentionally dark in every app theme. Monaco remains its dedicated dark editor theme until a separately validated light Monaco theme exists. Browser/native-webview content keeps its own page theme. These are documented exceptions, not token failures.
- `#fb6a22` is always paired with black foreground. Custom personal accents continue through contrast calculation, but every filled button/chip must satisfy AA text contrast; unsafe custom colors fall back to black or white at render time.

## Non-goals

- copying Codex brand assets, private Electron IPC, pets, or app-server internals;
- removing accent personalization or AIOS multi-pane workflow;
- a cosmetic-only pass that leaves competing token values in component code.

## Validation

- TypeScript and Rust tests remain green.
- Token-contract tests cover dark/light × default/custom accent and prove focus, warning/full-access, success, danger, and diff semantics stay immutable under accent switching.
- Contrast tests cover every preset plus a representative light and dark custom accent.
- Source checks reject new literal background/border values outside the token layer only in the shared shell allowlist (`App`, `ChatPane`, `Composer`, shared menus/buttons, browser/files/git chrome). Syntax highlighting, xterm/Monaco, media/canvas, webviews, and semantic status/diff colors are explicit exemptions.
- Screenshot baselines at normal and narrow pane widths cover chat empty, active streamed run, queued follow-ups, approval card, task summary, browser toolbar, terminal, and git diff under dark/default accent and light/custom accent.
