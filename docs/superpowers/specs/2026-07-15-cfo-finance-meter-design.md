# CFO finance meter design

## Goal

Show Firaz's monthly spending against a fixed budget in the AIOS supershell sidebar and idle dashboard, using the same compact visual language as the existing Claude and Codex usage limits. The meter should make overspending visible every day while preserving the separate cash-floor goal.

## Confirmed July baseline

- Income received: RM11,700 (RM5,700 salary + RM6,000 A-List)
- Cash available: RM5,400
- Spending/outflow so far: RM6,300
- July ending cash floor: RM5,000
- July total spending budget: RM6,700
- July remaining spending allowance: RM400
- August ending cash target: RM7,000
- Credit-card balance: approximately RM4,579, shown separately from gross cash

The RM6,300 figure is the user-confirmed baseline and also reconciles as RM11,700 received minus RM5,400 remaining. It is not reconstructed from the incomplete detailed transaction CSV.

## Chosen approach

Build one shared `FinanceGlance` feature with two presentations:

1. The sidebar shows a single monthly spend-limit bar, matching `UsageGlance` density.
2. The idle dashboard shows the same spend bar plus cash, debt, net cash, cash floor, remaining allowance, and next target.

This is preferable to a spend-only or cash-only display because spending discipline and bank growth are related but not interchangeable. Gross cash must never hide card debt.

## Runtime data

Create a small canonical runtime snapshot at `~/.aios/state/finance/cfo.json`. The Oracle/CFO workflow updates it when Firaz sends transaction or account screenshots. The file contains no bank credentials or full card numbers.

```json
{
  "updated_at": "2026-07-15T02:55:00+08:00",
  "currency": "MYR",
  "month": "2026-07",
  "income_received": 11700,
  "spent": 6300,
  "spend_budget": 6700,
  "cash": 5400,
  "cash_floor": 5000,
  "card_debt": 4578.91,
  "next_month_cash_target": 7000
}
```

All amounts are numeric MYR values. `net_cash` and `remaining_budget` are derived in code, not stored:

- `net_cash = cash - card_debt`
- `remaining_budget = spend_budget - spent`
- `spent_pct = spent / spend_budget * 100`
- `month_elapsed_pct` uses calendar days in the snapshot month and the local Malaysia date

New sales do not automatically increase `spend_budget`. A budget change requires an explicit CFO decision.

## Data boundary

Add one defensive Tauri command, `finance_snapshot`, that resolves and reads the state file and returns a typed nullable payload. Frontend components do not read arbitrary paths. Missing, malformed, negative, non-finite, or mismatched-month values are rejected or normalized at this boundary.

The command never infers spend from bank balances. Reconciliation happens in the CFO workflow before the snapshot is written.

## Sidebar presentation

Place `FinanceGlance` below the existing provider usage section when the sidebar is expanded. It uses the same typography, spacing, one-pixel progress rail, and 700 ms width transition as `UsageGlance`.

Example:

```text
finance
july spend                         rm6.3k / rm6.7k
[███████████████████░]             94% used
rm400 left · 16 days
```

The bar is capped visually at 100%, while the label may show more than 100%. The component stays compact: it does not show cash, debt, or category detail in the rail.

Finance colors are pace-aware rather than copied literally from rate limits:

- safe: spending percentage is no more than five percentage points ahead of month elapsed
- warning: spending is 5–15 points ahead, or remaining allowance is below 10%
- danger: spending is more than 15 points ahead or the budget is exceeded

For the confirmed July snapshot, 94% spent around 48% through the month is danger.

## Dashboard presentation

Add a `CfoFinanceCard` near the top of `IdleControlCenter`, after the command line and before recent panes. This is a decision card, not a full accounting dashboard.

It contains:

- primary spend bar: RM6,300 / RM6,700, 94% used
- time comparison: 48% of month elapsed
- remaining allowance: RM400 and days remaining
- gross cash: RM5,400
- card debt: RM4,579
- net cash: RM821
- current cash floor: RM5,000
- next target: RM7,000 ending August
- last-updated time

Cash and debt use distinct labels. Net cash is visually emphasized so gross bank balance cannot be mistaken for wealth. No charts, categories, editing controls, bank sync, or forecasting are included in this first version.

## Refresh behavior

Use one `useFinanceSnapshot` hook shared by sidebar and dashboard. It loads immediately and refreshes through the existing shared ticker every 30 seconds. Both surfaces consume the same normalized snapshot and derived calculations, preventing drift.

When the state file changes after a CFO screenshot update, both surfaces refresh without restarting the app.

## Empty, stale, and invalid states

- Missing file: hide the sidebar block; dashboard shows no finance card.
- Invalid payload: fail closed and log one diagnostic; never render misleading zeros.
- Snapshot older than 36 hours: render values with a muted `stale` label.
- Snapshot month differs from the current month: render `waiting for <month> baseline` instead of rolling old spend into the new month.
- Zero or negative budget: hide the bar and report a diagnostic.
- Spending above budget: bar remains full and the exact overage is shown.

## Components and files

- `src-tauri/src/finance.rs`: typed state-file reader and validation
- `src-tauri/src/lib.rs`: register `finance_snapshot`
- `src/lib/finance.ts`: types, invoke wrapper, derived calculations, formatting, pace status
- `src/components/dashboard/FinanceGlance.tsx`: shared sidebar block and hook
- `src/components/dashboard/CfoFinanceCard.tsx`: expanded idle-dashboard card
- `src/components/SidebarUsage.tsx` or its parent composition: render finance below provider usage without changing provider behavior
- `src/components/IdleControlCenter.tsx`: place the dashboard card

Keep finance logic isolated from `UsageGlance`; share visual primitives only where that reduces duplication without coupling financial semantics to provider reset windows.

## Testing

Unit tests cover:

- RM6,300 / RM6,700 = 94.03% and RM400 remaining
- net cash = RM821.09 from RM5,400 cash and RM4,578.91 debt
- leap years, month length, day boundaries, and Malaysia-local elapsed percentage
- safe, warning, danger, exceeded, zero-budget, stale, and month-mismatch states
- malformed JSON and non-finite or negative inputs fail closed
- spend percentages above 100% retain their true label while visual width caps at 100%

Component tests verify:

- sidebar remains hidden with no valid snapshot
- sidebar stays compact and contains no debt details
- dashboard renders gross cash, debt, net cash, floor, target, and last update
- sidebar and dashboard use the same derived snapshot values

Verification includes the focused frontend/Rust tests, the existing bundle-boundary tests, a production build, and visual inspection of expanded sidebar plus idle dashboard at normal and narrow widths.

## Non-goals

- Direct bank login or bank API integration
- Automatic OCR inside supershell
- Transaction-category drilldown
- Editing budgets in the UI
- Treating expected sales as received income
- Hiding debt from the headline financial position

