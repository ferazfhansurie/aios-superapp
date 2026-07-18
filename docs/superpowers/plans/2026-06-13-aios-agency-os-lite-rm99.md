# aios agency os lite rm99 implementation plan

> **for agentic workers:** required sub-skill: use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. steps use checkbox (`- [ ]`) syntax for tracking.

**goal:** build a self-serve rm99 agency onboarding pane inside aios shell that captures an agency profile, generates the first 3 client workspaces, and launches useful agency operator prompts.

**architecture:** add one first-class pane, `agency os`, backed by a focused localStorage domain module. keep v1 local-first and prompt-driven: no billing, no external integrations, no crm rewrite. the pane collects the 20-question agency profile, persists it, renders the generated workspace, and can open seeded chat prompts for proposal, client reply, report, and daily briefing workflows.

**tech stack:** react 19, typescript, tauri shell frontend, lucide-react icons, node test runner with `--experimental-strip-types`, localStorage persistence.

---

## file structure

- create `src/lib/agencyOs.ts`
  - owns types, wizard questions, validation, localStorage persistence, workspace derivation, and chat prompt builders.
- create `src/lib/agencyOs.test.ts`
  - covers profile validation, workspace derivation, persistence fallback, and prompt output.
- create `src/components/AgencyOsPane.tsx`
  - renders onboarding, generated workspace, workflow buttons, reset/edit actions.
- modify `src/lib/apps.ts`
  - adds `{ type: "agency-os" }` pane content and first-class sidebar/catalog entry.
- modify `src/App.tsx`
  - lazy-loads `AgencyOsPane`, renders the pane kind, and includes it in idle warmup only if needed.
- optional modify `src/App.css`
  - only if existing utility classes are not enough for a polished dense pane.
- modify `package.json`
  - add `src/lib/agencyOs.test.ts` to the relevant test command or create `test:agency-os`.

## non-goals

- no payment implementation in this milestone.
- no user auth.
- no cloud sync.
- no whatsapp/email/doc integration.
- no full crm.
- no custom agency workflow builder.

## task 1: domain model and tests

**files:**

- create: `src/lib/agencyOs.ts`
- create: `src/lib/agencyOs.test.ts`
- modify: `package.json`

- [ ] **step 1: write failing tests for the wizard questions**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { AGENCY_OS_QUESTIONS } from "./agencyOs.ts";

test("agency os asks exactly 20 onboarding questions", () => {
  assert.equal(AGENCY_OS_QUESTIONS.length, 20);
  assert.deepEqual(
    AGENCY_OS_QUESTIONS.map((q) => q.id),
    [
      "agencyName",
      "founderName",
      "services",
      "niche",
      "activeClients",
      "monthlyRevenueRange",
      "teamSize",
      "highestMarginService",
      "painfulDeliveryTask",
      "painfulSalesTask",
      "leadSources",
      "conversationChannels",
      "proposalFormat",
      "reportingFormat",
      "weeklyDeliverables",
      "clientObjections",
      "replyTone",
      "workingHours",
      "topClients",
      "firstWeekWin",
    ],
  );
});
```

- [ ] **step 2: write failing tests for validation and workspace derivation**

```ts
import {
  createEmptyAgencyProfile,
  deriveAgencyWorkspace,
  validateAgencyProfile,
} from "./agencyOs.ts";

test("profile validation requires core activation fields", () => {
  const profile = createEmptyAgencyProfile();
  const result = validateAgencyProfile(profile);
  assert.equal(result.valid, false);
  assert.ok(result.missing.includes("agencyName"));
  assert.ok(result.missing.includes("services"));
  assert.ok(result.missing.includes("firstWeekWin"));
});

test("workspace derives 3 client slots and core kits", () => {
  const workspace = deriveAgencyWorkspace({
    ...createEmptyAgencyProfile(),
    agencyName: "juta",
    founderName: "firaz",
    services: "websites, content, ai ops",
    niche: "malaysian smes",
    topClients: "pang, rais, cnb",
    firstWeekWin: "save 5 hours on proposals",
  });

  assert.equal(workspace.clientSlots.length, 3);
  assert.equal(workspace.clientSlots[0].name, "pang");
  assert.ok(workspace.kits.some((kit) => kit.id === "sales"));
  assert.ok(workspace.kits.some((kit) => kit.id === "delivery"));
});
```

- [ ] **step 3: implement minimal `agencyOs.ts` types and question catalog**

```ts
export interface AgencyProfile {
  agencyName: string;
  founderName: string;
  services: string;
  niche: string;
  activeClients: string;
  monthlyRevenueRange: string;
  teamSize: string;
  highestMarginService: string;
  painfulDeliveryTask: string;
  painfulSalesTask: string;
  leadSources: string;
  conversationChannels: string;
  proposalFormat: string;
  reportingFormat: string;
  weeklyDeliverables: string;
  clientObjections: string;
  replyTone: string;
  workingHours: string;
  topClients: string;
  firstWeekWin: string;
}
```

- [ ] **step 4: implement workspace derivation and prompt builders**

include exported functions:

- `createEmptyAgencyProfile(): AgencyProfile`
- `validateAgencyProfile(profile): { valid: boolean; missing: (keyof AgencyProfile)[] }`
- `deriveAgencyWorkspace(profile): AgencyWorkspace`
- `buildAgencyPrompt(profile, kind): string`
- `loadAgencyProfile(): AgencyProfile | null`
- `saveAgencyProfile(profile): void`
- `clearAgencyProfile(): void`

- [ ] **step 5: run the agency os tests**

run:

```bash
pnpm exec node --experimental-strip-types --test src/lib/agencyOs.test.ts
```

expected: pass.

- [ ] **step 6: wire test script**

either add `src/lib/agencyOs.test.ts` to `test:chatpane`, or add:

```json
"test:agency-os": "node --experimental-strip-types --test src/lib/agencyOs.test.ts"
```

- [ ] **step 7: run relevant tests**

run:

```bash
pnpm test:agency-os
```

expected: pass.

- [ ] **step 8: commit**

```bash
git add package.json src/lib/agencyOs.ts src/lib/agencyOs.test.ts
git commit -m "feat: add agency os domain model"
```

## task 2: agency os pane ui

**files:**

- create: `src/components/AgencyOsPane.tsx`
- optional modify: `src/App.css`

- [ ] **step 1: create the pane shell**

implement `AgencyOsPane` with:

- compact header: "agency os lite" and "rm99/month wedge"
- activation summary
- onboarding progress
- form area
- generated workspace area
- workflow buttons

- [ ] **step 2: render all 20 questions from `AGENCY_OS_QUESTIONS`**

requirements:

- questions render from data, not hardcoded duplicated jsx.
- textarea for multi-line fields.
- small inputs for count/range fields.
- progress copy says `x/20 answered`.
- no marketing hero; this is a work pane.

- [ ] **step 3: persist draft changes**

use `loadAgencyProfile()` on mount and `saveAgencyProfile()` on changes.

empty localStorage must not crash. malformed localStorage must reset gracefully.

- [ ] **step 4: show generated workspace once core fields exist**

core fields:

- agency name
- services
- niche
- top clients
- first week win

workspace must show:

- agency profile summary
- first 3 client slots
- command center bullets
- sales kit
- delivery kit
- daily briefing kit

- [ ] **step 5: add reset/edit actions**

include:

- reset profile button with confirmation
- edit mode toggle when workspace is generated
- copy profile summary button if clipboard is available

- [ ] **step 6: manual browser check**

run:

```bash
pnpm dev
```

expected: vite starts cleanly. open the local url and verify the pane renders without overflow at desktop and narrow widths.

- [ ] **step 7: commit**

```bash
git add src/components/AgencyOsPane.tsx
# only add src/App.css if this task actually changed it
git commit -m "feat: add agency os onboarding pane"
```

## task 3: register the pane in aios shell

**files:**

- modify: `src/lib/apps.ts`
- modify: `src/App.tsx`

- [ ] **step 1: add pane content type**

in `src/lib/apps.ts`, add:

```ts
| { type: "agency-os" }
```

to `PaneContent`.

- [ ] **step 2: add catalog entry**

import a lucide icon, preferably `BriefcaseBusiness` or `Rocket`, then add to `SPAWN`:

```ts
{
  id: "agency-os",
  kind: { type: "agency-os" },
  icon: BriefcaseBusiness,
  label: "agency os",
  group: "tools",
  firstClass: true,
}
```

- [ ] **step 3: lazy-load component in `App.tsx`**

add:

```ts
const AgencyOsPane = lazy(() =>
  import("./components/AgencyOsPane").then((m) => ({ default: m.AgencyOsPane })),
);
```

- [ ] **step 4: render pane kind**

find the pane render switch in `App.tsx` and add a branch for `kind.type === "agency-os"` that renders:

```tsx
<AgencyOsPane
  onOpenChat={(seed) => spawn({ type: "chat", seed }, "agency operator")}
/>
```

adapt to the existing local spawn function signature in that render scope.

- [ ] **step 5: make pane context detail quiet**

in `paneContextDetail`, return undefined for `agency-os` or a short detail like `rm99 agency setup`.

- [ ] **step 6: run typecheck/build**

run:

```bash
pnpm build
```

expected: typescript and vite build pass.

- [ ] **step 7: commit**

```bash
git add src/lib/apps.ts src/App.tsx
git commit -m "feat: register agency os pane"
```

## task 4: workflow chat seeds

**files:**

- modify: `src/lib/agencyOs.ts`
- modify: `src/lib/agencyOs.test.ts`
- modify: `src/components/AgencyOsPane.tsx`

- [ ] **step 1: add tests for prompt builders**

cover:

- `messy-request`
- `proposal`
- `client-report`
- `daily-briefing`

assert each prompt includes agency name, services, niche, and concrete output instructions.

- [ ] **step 2: implement prompt builder copy**

the prompts must instruct the chat agent to produce practical outputs only:

- summary
- client-facing draft
- internal task list
- missing questions
- next action

- [ ] **step 3: add workflow buttons**

buttons:

- turn client message into plan
- draft proposal
- draft client report
- daily agency briefing

each button calls `onOpenChat(buildAgencyPrompt(profile, kind))`.

- [ ] **step 4: test**

run:

```bash
pnpm test:agency-os
pnpm build
```

expected: pass.

- [ ] **step 5: commit**

```bash
git add src/lib/agencyOs.ts src/lib/agencyOs.test.ts src/components/AgencyOsPane.tsx
git commit -m "feat: seed agency operator workflows"
```

## task 5: launch copy and beta tracking docs

**files:**

- create: `docs/agency-os-lite/landing-copy.md`
- create: `docs/agency-os-lite/beta-tracking.md`
- modify: `docs/superpowers/specs/2026-06-13-aios-agency-os-lite-rm99-design.md`

- [ ] **step 1: write landing copy**

include:

- headline
- subheadline
- 3 bullets
- demo script
- cta
- rm99 offer
- cancellation/refund line

- [ ] **step 2: write beta tracking template**

columns:

- founder
- agency
- niche
- paid/trial
- activation date
- onboarding completed
- first useful output
- hours saved claim
- confusion points
- upgrade potential
- next follow-up

- [ ] **step 3: update spec with docs links**

link the launch copy and beta tracking docs from the launch assets section.

- [ ] **step 4: commit**

```bash
git add docs/agency-os-lite docs/superpowers/specs/2026-06-13-aios-agency-os-lite-rm99-design.md
git commit -m "docs: add agency os launch assets"
```

## final verification

- [ ] run unit tests:

```bash
pnpm test:agency-os
```

- [ ] run existing focused suite:

```bash
pnpm test:chatpane
```

- [ ] run production build:

```bash
pnpm build
```

- [ ] run app locally:

```bash
pnpm dev
```

- [ ] verify:

  - agency os appears in sidebar/catalog.
  - wizard shows 20 questions.
  - progress updates as answers are entered.
  - profile persists after refresh.
  - workspace appears after core fields are answered.
  - workflow buttons open chat panes with useful seeds.
  - no text overflows at narrow width.
  - existing modified `src-tauri/src/chat.rs` is not reverted or touched unless separately requested.

## rollout

ship internally first:

1. onboard adletic as the demo agency.
2. onboard rais as beta user 1.
3. onboard pang-style agency as beta user 2.
4. collect confusion points after first 7 days.
5. only then add payment gates.
