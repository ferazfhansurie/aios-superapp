import { formatMyr, useFinanceSnapshot } from "../../lib/finance";
import { FinanceGlance } from "./FinanceGlance";

export function CfoFinanceCard() {
  const f = useFinanceSnapshot();
  if (!f) return null;
  return <section className="aios-fade-in w-full rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel)]/55 p-4">
    <FinanceGlance />
    {!f.monthMismatch && <div className="mt-4 grid grid-cols-2 gap-3 text-[11px] sm:grid-cols-4">
      <Metric label="personal cash" value={formatMyr(f.cash)} />
      <Metric label="Adletic cash" value={formatMyr(f.business_cash)} />
      <Metric label="liquid cash" value={formatMyr(f.liquidCash)} strong />
      <Metric label="money owed" value={formatMyr(f.receivableTotal)} />
      <Metric label="projected cash" value={formatMyr(f.projectedCash)} />
      <Metric label="card debt" value={formatMyr(f.card_debt)} />
      <Metric label="net cash" value={formatMyr(f.netCash)} />
      <Metric label="cash floor" value={formatMyr(f.cash_floor)} />
      <Metric label="next target" value={formatMyr(f.next_month_cash_target)} />
    </div>}
    {!f.monthMismatch && f.receivables?.map((r) => <div key={r.id} className="mt-3 text-[10px] text-[var(--color-muted)]">{r.person} owes {formatMyr(r.amount)} · {formatMyr(r.gross)} less {formatMyr(r.deductions)} deductions{r.note ? ` · ${r.note}` : ""}</div>)}
    <div className="mt-3 text-right font-mono text-[9px] text-[var(--color-faint)]">updated {new Date(f.updated_at).toLocaleString()}</div>
  </section>;
}

function Metric({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return <div><div className="text-[9px] uppercase tracking-wider text-[var(--color-muted)]">{label}</div><div className={`font-mono ${strong ? "text-[14px] font-semibold text-[var(--color-accent)]" : "text-[12px] text-[var(--color-text-2)]"}`}>{value}</div></div>;
}
