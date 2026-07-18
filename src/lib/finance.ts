import { useCallback, useEffect, useState } from "react";
import { invoke } from "./tauri.ts";
import { useSharedInterval } from "./ticker.ts";

export type FinanceAdjustment = { id: string; at: string; kind: "expense" | "refund" | "correction"; amount: number; category?: string; note?: string; source?: string };
export type FinanceReceivable = { id: string; person: string; gross: number; deductions: number; amount: number; note?: string };
export type FinanceSnapshot = { schema_version: 1; revision: number; updated_at: string; currency: "MYR"; month: string; income_received: number; opening_spent: number; spend_budget: number; cash: number; business_cash?: number; cash_floor: number; card_debt: number; next_month_cash_target: number; adjustments: FinanceAdjustment[]; receivables?: FinanceReceivable[] };
export type FinanceStatus = "safe" | "warning" | "danger";

const round = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const klParts = (date: Date) => Object.fromEntries(new Intl.DateTimeFormat("en", { timeZone: "Asia/Kuala_Lumpur", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date).map((p) => [p.type, p.value]));

export function deriveFinanceSnapshot(snapshot: FinanceSnapshot, now = new Date()) {
  const spent = round(snapshot.opening_spent + snapshot.adjustments.reduce((sum, a) => sum + a.amount, 0));
  const remainingBudget = round(snapshot.spend_budget - spent);
  const spentPct = round(spent / snapshot.spend_budget * 100);
  const p = klParts(now);
  const currentMonth = `${p.year}-${p.month}`;
  const daysInMonth = new Date(Date.UTC(Number(p.year), Number(p.month), 0)).getUTCDate();
  const day = Number(p.day);
  const monthElapsedPct = round(day / daysInMonth * 100);
  const ahead = spentPct - monthElapsedPct;
  const overBudget = Math.max(0, round(spent - snapshot.spend_budget));
  const receivableTotal = round((snapshot.receivables || []).reduce((sum, receivable) => sum + receivable.amount, 0));
  const liquidCash = round(snapshot.cash + (snapshot.business_cash || 0));
  const projectedCash = round(liquidCash + receivableTotal);
  const status: FinanceStatus = overBudget > 0 || ahead > 15 ? "danger" : ahead > 5 || remainingBudget < snapshot.spend_budget * 0.1 ? "warning" : "safe";
  return { ...snapshot, business_cash: snapshot.business_cash || 0, spent, remainingBudget, liquidCash, netCash: round(liquidCash - snapshot.card_debt), receivableTotal, projectedCash, cashFloorGap: Math.max(0, round(snapshot.cash_floor - liquidCash)), projectedFloorGap: Math.max(0, round(snapshot.cash_floor - projectedCash)), spentPct, barPct: Math.min(100, Math.max(0, spentPct)), monthElapsedPct, daysRemaining: Math.max(0, daysInMonth - day), overBudget, status, stale: now.getTime() - new Date(snapshot.updated_at).getTime() > 36 * 3600_000, monthMismatch: snapshot.month !== currentMonth };
}

export const formatMyr = (n: number) => `RM${new Intl.NumberFormat("en-MY", { maximumFractionDigits: 2 }).format(n)}`;
export const formatMyrCompact = (n: number) => n >= 1000 ? `RM${round(n / 1000)}k` : formatMyr(n);

export function useFinanceSnapshot() {
  const [snapshot, setSnapshot] = useState<FinanceSnapshot | null>(null);
  const load = useCallback(async () => {
    try { setSnapshot(await invoke<FinanceSnapshot | null>("finance_snapshot")); }
    catch { setSnapshot(null); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useSharedInterval(30_000, () => void load());
  return snapshot ? deriveFinanceSnapshot(snapshot) : null;
}
