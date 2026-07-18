import { formatMyr, formatMyrCompact, useFinanceSnapshot } from "../../lib/finance";

const color = { safe: "var(--color-accent)", warning: "var(--color-warning)", danger: "var(--color-danger)" };

export function FinanceGlance() {
  const finance = useFinanceSnapshot();
  if (!finance) return null;
  const month = new Date(`${finance.month}-01T00:00:00+08:00`).toLocaleDateString("en-MY", { month: "long" }).toLowerCase();
  return (
    <div className="flex flex-col gap-2 border-t border-[var(--color-border)] pt-3">
      <span className="text-[10px] font-medium uppercase tracking-widest text-[var(--color-muted)]">finance</span>
      {finance.monthMismatch ? <span className="text-[10px] text-[var(--color-warning)]">waiting for {month} baseline</span> : <>
        <div className="flex items-baseline justify-between text-[10px]"><span className="text-[var(--color-muted)]">{month} spend</span><span className="font-mono text-[var(--color-text-2)]">{formatMyrCompact(finance.spent)} / {formatMyrCompact(finance.spend_budget)}</span></div>
        <div className="h-1 overflow-hidden rounded-full bg-[var(--color-panel-2)]"><div className="h-full rounded-full transition-[width] duration-700" style={{ width: `${finance.barPct}%`, background: color[finance.status] }} /></div>
        <div className="flex justify-between text-[10px]"><span className="font-mono" style={{ color: color[finance.status] }}>{Math.round(finance.spentPct)}% used</span><span className="text-[var(--color-faint)]">{finance.overBudget ? `${formatMyr(finance.overBudget)} over` : `${formatMyr(finance.remainingBudget)} left`} · {finance.daysRemaining} days{finance.stale ? " · stale" : ""}</span></div>
      </>}
    </div>
  );
}
