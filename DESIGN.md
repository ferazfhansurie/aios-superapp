# AIOS Design System

The reference every AIOS superapp surface follows. Derived from the **chat surface**
(`src/components/ChatPane.tsx`) — the gold standard — and codified at the token level
in `src/App.css` so the whole app inherits the look through the existing
`var(--color-*)` usage.

If you're styling a new pane or component, read this first. The goal is that
nothing you build looks "a bit off" next to the chat.

---

## 1. Philosophy

**Calm. Chat-first. Restrained accent.**

The chat is the soul of AIOS, and it works because it does *less*:

- **A calm near-black ground** with generous negative space. The UI recedes; the
  content (your conversation, your work) is the only thing that's loud.
- **Layered, soft surfaces** — bg → panel → panel-2 step up gently, never in hard
  slabs. Elevation is felt, not stacked.
- **Soft hairline borders.** Dividers whisper. A border is there to separate, not
  to decorate.
- **One medium-weight headline moment**, lots of quiet body text in a clear
  four-step hierarchy.
- **The orange accent is precious.** It appears only where it *means* something:
  the primary action, the active/selected state, the focus edge. It is never the
  default border color, never every hover, never decoration. When everything is
  orange, nothing is.
- **Mono for the ambient.** Status, helper hints, tool names, file paths — the
  machine's quiet voice — are monospaced and faint.

When in doubt: make it quieter, give it more space, and don't reach for accent.

---

## 2. Color tokens — and when to use each

All colors are CSS custom props defined in `src/App.css`. **Token names are frozen** —
`lib/theme.ts` overrides the `--color-accent*` family (plus `--color-cursor` /
`--color-selection`) at runtime for live theme + accent switching, and
`ThemeSwitcher` / the accent swatches bind to these exact names. Change *values*,
never names.

Always consume via `var(--color-…)` (or the matching Tailwind `bg-[var(--color-…)]`)
so light/dark/accent switching keeps working. **Never hardcode a hex in a component.**

### Surfaces (dark → light layering)

| Token                   | Role | Use it for |
|-------------------------|------|------------|
| `--color-bg`            | App ground | Window background, empty/hero surfaces, the chat transcript ground. The calm base everything sits on. |
| `--color-panel`         | Chrome | Sidebars, sticky top bar, pane-header bars, inset toolbars. One step up from ground. |
| `--color-panel-2`       | Card / control | The standard card and the composer surface. Tool cards, dropdowns, popovers, pills. The "thing sitting on the ground." |
| `--color-pane`          | Deepest | Terminal interior — the darkest layer (an inset well). Rarely used outside terminal chrome. |
| `--color-border`        | Hairline | The default divider. `border-b` on headers, separators, resting card edges. |
| `--color-border-strong` | Emphasis edge | The composer, dropdown menus, popovers, hover state of a resting border. Use sparingly — it's "this is liftable/important." |

Layering intent (dark): `bg 0.155 → panel 0.183 → panel-2 0.205`, deepest `pane 0.132`.
The steps are intentionally tight (~0.022 L) so elevation reads soft.

### Text (four-step hierarchy)

| Token            | Role | Use it for |
|------------------|------|------------|
| `--color-text`   | Primary | Headings, the hero title, active labels, strong/bold inline. |
| `--color-text-2` | Body | Default body copy and **assistant prose** — the chat sets bodies one notch under pure white for calm. Use this for most readable text. |
| `--color-muted`  | Secondary | Labels, pane-header titles, tool names/args, resting nav rows. |
| `--color-faint`  | Quietest | Helper text, placeholders, result footers, the `·` separators, dot/divider tints. |

Rule: body text is `text-2`, not `text`. Reserve full-strength `text` for things
that should pull the eye (titles, active item, the bold inside prose).

### Accent — adletic orange (handle with care; see §6)

| Token                  | Use it for |
|------------------------|------------|
| `--color-accent`       | The **one** primary action (send button), the active/selected indicator, focus edge, link color. |
| `--color-accent-hover` | Hover/pressed on an accent-filled surface (e.g. the send button). |
| `--color-accent-soft`  | Low-alpha wash for the *active* state: selected pill bg, the user message bubble, nav-rail active row, selected menu item. The calm way to show "this one." |
| `--color-accent-dim`   | Disabled / low-emphasis accent. |
| `--color-cursor`, `--color-selection`, `--color-highlight` | Terminal caret, text-selection wash, highlight. |

### Status — semantic, used sparingly

| Token | Meaning | Where |
|-------|---------|-------|
| `--color-success` | done / allowed / live | the green status dot, approval "allowed", copy-confirm check |
| `--color-warning` | idle / caution | idle status dot |
| `--color-info`    | dormant / informational | dormant status dot |
| `--color-danger`  | error / stop / deny | stop button, tool errors, denied approval |
| `--color-cold`    | inactive / off | cold status dot |

Status colors are for *state*, not styling. Don't use `success` green as a "nice
accent" — it carries meaning.

---

## 3. Type scale

Defined as `--aios-text-*` in `@theme`. (Namespaced `--aios-` on purpose: Tailwind
v4 treats bare `--text-*` inside `@theme` as a utility-generating namespace, so
using it would silently re-map `text-sm` etc. across the app. These are additive
`var()` tokens.)

| Token                | px      | Use |
|----------------------|---------|-----|
| `--aios-text-hero`   | 30      | The empty-state hero headline. Once per landing surface. |
| `--aios-text-title`  | 17      | Section titles, H1 inside prose. |
| `--aios-text-lg`     | 15      | The composer input. |
| `--aios-text-body`   | 14      | Default body, message bubbles. |
| `--aios-text-sm`     | 12.5    | Dense UI, menu items, code. |
| `--aios-text-xs`     | 11.5    | Pill labels, tool args. |
| `--aios-text-2xs`    | 11      | Mono footer helper, pane-header titles. |
| `--aios-text-micro`  | 10.5    | Result footers, code-fence lang labels. |

**Weights:** body is regular (400). The hero is **medium (500)** — that's the
heaviest weight in normal UI. Headings inside prose go semibold (600). Avoid bold
(700) except the brand `aios` wordmark. Tight tracking (`-0.02em`) on the hero only.

**Families:** `--font-sans` (SF Pro / system) for everything human-readable;
`--font-mono` (SF Mono / system mono) for the machine's voice — status, helpers,
tool names, file paths, code.

---

## 4. Radii & spacing

### Radii — `--aios-radius-*`

The chat speaks in soft, generous rounding.

| Token                 | px    | Use |
|-----------------------|-------|-----|
| `--aios-radius-xs`    | 6     | Inline code chips, tiny tags. |
| `--aios-radius-sm`    | 8     | Pane-card chrome, code blocks, menu rows. |
| `--aios-radius-md`    | 10    | Small solid buttons, approval action buttons. |
| `--aios-radius-lg`    | 12    | Tool cards, dropdown menus, `/`+`@` overlays. |
| `--aios-radius-xl`    | 16    | **The composer surface — the signature radius.** |
| `--aios-radius-pill`  | 9999  | Pills, status dots, the round send button. |

Bigger surface → bigger radius. The composer (xl) is the most rounded thing in the
app; that softness is part of why the chat feels calm.

### Spacing — `--aios-space-*` (4px base)

`1=4 · 2=8 · 3=12 · 4=16 · 5=20 · 6=24`. Notable anchors from the chat:
- **`--aios-space-3` (12px)** — standard pane-header horizontal padding.
- **`--aios-space-5` (20px)** — composer horizontal padding (`px-5`).

### Header heights — `--aios-h-*`

The app has **two** header conventions; don't conflate them:
- **`--aios-h-chrome` (28px)** — the outer pane-card title strip (`PaneCard` in
  `App.tsx`): a dense 28px bar with a status dot + mono muted label. This is window
  chrome around a pane.
- **`--aios-h-header` (36px)** — the in-pane tool toolbar (Files, Memory,
  Automations, Bridges, Plugins, Browser). This is the `.pane-header` utility.

### Elevation

One shadow token: `--aios-shadow-pop` (`0 12px 32px -8px rgba(0,0,0,0.5)`) — the
chat's soft pop for floating surfaces (composer, dropdowns, popovers, toasts).
Default surfaces are flat; only *floating* things get the shadow.

---

## 5. Core patterns (utility classes)

Defined in `src/App.css`. Use the class for the shared skeleton, then layer Tailwind
utilities for one-off tweaks. They're plain CSS (not `@apply`) so they're stable
regardless of the utility pipeline.

### `.pane-header` + `.pane-header__title`
The consistent top bar of an in-pane tool view: 36px tall, hairline bottom border,
12px horizontal padding, vertically centered. The title uses `.pane-header__title`
(mono, 11px, muted — the chat's quiet voice). Most tool panes already match this
shape; converging them onto the class makes every pane's bar identical.

### `.surface` / `.surface-card` / `.surface-pop`
- `.surface` — base inset fill + hairline edge (`panel` + `border`). For inset
  regions: lists, toolbars.
- `.surface-card` — the standard card: `panel-2` fill, hairline border, **12px**
  radius, clipped. The default container for a discrete thing (the chat's tool/info
  cards).
- `.surface-pop` — a *floating* surface: `panel-2`, **strong** border, **16px**
  radius, soft pop shadow. For popovers, dropdowns, the hero composer.

### `.pill` (+ `.pill--active`)
The small rounded control from the composer (permission / effort / model chips,
plan & goal toggles). Resting state is deliberately quiet — translucent panel fill,
hairline border, secondary text; hover lifts border + text **one** step. Add
`.pill--active` for the selected/on state — the **only** place accent touches a
pill (soft wash + accent edge). This is how AIOS shows "this one is on" calmly.

### `.hero-title`
The empty-state headline ("what should we work on?"): 30px, medium weight, tight
tracking, primary text. The single biggest type moment — one per empty/landing
surface, centered, with breathing room above the composer.

### `.helper-line`
The faint mono helper line ("claude · ready · /commands @files"). Quiet,
monospaced, faint — for ambient hints and status footers. Never primary content.

### `.focus-accent`
The composer's focus treatment: a restrained accent edge on `:focus-within` (no
glow, no double-ring). Drop it on text-entry surfaces so focus is consistently the
accent's job.

### Status dots (already in App.css)
`.status-dot` + `--active` (success, pulsing) / `--idle` (warning) / `--dormant`
(info) / `--cold`. 8px round. The pulsing green dot = live; everything else is a
calmer state. Use these for any "is this thing alive" indicator.

### The hero composer (assembled pattern)
The signature composition, for reference when building any prompt/entry surface:
a `.surface-pop` (16px, strong border, soft shadow) wrapping a transparent-bg
textarea (15px body) over a row of `.pill` controls, with the **one** accent-filled
round send button on the right, `.focus-accent` for the focus edge, and a
`.helper-line` beneath. Accent appears exactly twice: the send button and the focus
edge. That restraint is the whole point.

---

## 6. Accent-usage rules

The single most important rule in this system. **Adletic orange is reserved for
PRIMARY, ACTIVE, and FOCUS — nothing else.**

**Use accent for:**
- The **one** primary action on a surface (the send button: accent fill, `bg`-color
  text).
- The **active / selected** state (selected pill, active nav row, current menu item,
  the user's own message bubble) — usually via the soft `--color-accent-soft` wash,
  not a full fill.
- The **focus** edge on inputs (`.focus-accent` / `focus-within:border-accent`).
- **Links** and the live brand wordmark.

**Never use accent for:**
- Default borders. Resting borders are `--color-border`. (Hover → `border-strong`,
  *not* accent.)
- Generic hover states. Hover lifts text/border one neutral step; it does not turn
  orange.
- Decoration, dividers, body text, or "to add some color." It carries meaning.
- More than one primary action per surface. If two things are accent-filled, demote
  one to a neutral pill.

Litmus test: if you removed all accent from a screen, the *only* things that should
become ambiguous are "what's the primary button," "which item is selected," and
"what's focused." If anything else changes meaning, accent was overused.

---

## 7. How to apply this to a new pane

1. **Use the token system; hardcode nothing.** Backgrounds via
   `bg-[var(--color-bg|panel|panel-2)]`, text via the four text tokens, borders via
   `border-[var(--color-border)]` / `…-border-strong`. This alone makes the pane
   theme-correct in light/dark and accent-aware for free.
2. **Top it with `.pane-header`** (or the 28px chrome if it's a pane-card strip).
   Title = `.pane-header__title` (mono, muted). Right-align any pane actions as
   small ghost icon buttons (muted → hover text).
3. **Put discrete content in `.surface-card`s.** Floating things (menus, popovers)
   get `.surface-pop`. Match the radius to the size (§4).
4. **Controls are `.pill`s.** Quiet at rest; `.pill--active` for on/selected. Toggle
   groups and chips all use the same pill.
5. **Honor the type hierarchy.** Body is `text-2`; reserve `text` for the one thing
   that should pull focus. Use the `--aios-text-*` sizes; don't invent new ones.
6. **Spend accent like §6 says.** One primary action, active state, focus. Otherwise
   neutral.
7. **Use mono + faint for the machine's voice** — status, counts, paths, hints
   (`.helper-line`). Sans for anything a human reads as prose.
8. **Leave room.** Generous padding and gaps; let the ground breathe. If it feels
   busy, it's too busy — the chat's calm comes from restraint and space.

Build it, then put it next to a chat pane. If it reads heavier, louder, or more
colorful than the chat, pull it back until it doesn't.

---

## 8. Token reference (quick map)

- **Colors:** `--color-{bg,panel,panel-2,pane,border,border-strong,text,text-2,muted,faint,accent,accent-hover,accent-dim,accent-soft,cursor,selection,highlight,success,success-glow,warning,info,danger,cold}` — defined in `@theme` (dark fallback) and re-declared per `html[data-theme="dark"|"light"]`. Accent family + cursor/selection are runtime-overridden by `lib/theme.ts`.
- **Radii:** `--aios-radius-{xs,sm,md,lg,xl,pill}`
- **Type:** `--aios-text-{hero,title,lg,body,sm,xs,2xs,micro}`
- **Spacing:** `--aios-space-{1..6}`
- **Heights:** `--aios-h-{chrome,header}`
- **Elevation:** `--aios-shadow-pop`
- **Fonts:** `--font-sans`, `--font-mono`
- **Utility classes:** `.pane-header`, `.pane-header__title`, `.surface`, `.surface-card`, `.surface-pop`, `.pill`, `.pill--active`, `.hero-title`, `.helper-line`, `.focus-accent`, `.status-dot(--active|--idle|--dormant|--cold)`

All source-of-truth values live in `src/App.css`. This doc explains the *why* and
*when*; the CSS is the *what*.
