// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";
import { deriveFinanceSnapshot } from "./finance.ts";

const snapshot = { schema_version: 1, revision: 1, updated_at: "2026-07-15T02:55:00+08:00", currency: "MYR", month: "2026-07", income_received: 11700, opening_spent: 6300, spend_budget: 6700, cash: 5400, cash_floor: 5000, card_debt: 4578.91, next_month_cash_target: 7000, adjustments: [] };

test("derives verified July totals and danger pace", () => {
  const d = deriveFinanceSnapshot(snapshot, new Date("2026-07-15T03:00:00+08:00"));
  assert.equal(d.spent, 6300);
  assert.equal(d.remainingBudget, 400);
  assert.equal(d.netCash, 821.09);
  assert.equal(d.spentPct, 94.03);
  assert.equal(d.barPct, 94.03);
  assert.equal(d.daysRemaining, 16);
  assert.equal(d.status, "danger");
});

test("caps the bar but retains actual overage", () => {
  const d = deriveFinanceSnapshot({ ...snapshot, opening_spent: 7000 }, new Date("2026-07-31T03:00:00+08:00"));
  assert.equal(d.spentPct, 104.48);
  assert.equal(d.barPct, 100);
  assert.equal(d.overBudget, 300);
});

test("detects stale and month mismatch", () => {
  const d = deriveFinanceSnapshot(snapshot, new Date("2026-08-02T03:00:00+08:00"));
  assert.equal(d.stale, true);
  assert.equal(d.monthMismatch, true);
});

test("keeps receivables out of actual cash and exposes projected cash", () => {
  const d = deriveFinanceSnapshot({ ...snapshot, cash: 2513.68, business_cash: 2350, cash_floor: 4000, receivables: [{ id: "faeez", person: "Faeez", gross: 2700, deductions: 600, amount: 2100, note: "medicine and petrol" }] }, new Date("2026-07-17T00:01:00+08:00"));
  assert.equal(d.receivableTotal, 2100);
  assert.equal(d.liquidCash, 4863.68);
  assert.equal(d.projectedCash, 6963.68);
  assert.equal(d.cashFloorGap, 0);
  assert.equal(d.projectedFloorGap, 0);
});
