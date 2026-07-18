export interface ConversationRailItem {
  id: string;
  label: string;
}

/** A quiet left-edge map of meaningful beats in a long conversation. It stays
 * outside the reading column; hover exposes context and click jumps to the
 * corresponding transcript anchor. */
export function ConversationRail({
  items,
  onNavigate,
}: {
  items: ConversationRailItem[];
  onNavigate: (id: string) => void;
}) {
  if (items.length < 2) return null;
  const last = items.length - 1;
  return (
    <nav
      aria-label="conversation map"
      className="absolute -left-5 top-1 z-10 hidden w-4 flex-col items-start gap-1.5 md:flex"
    >
      {items.map((item, index) => (
        <button
          type="button"
          key={item.id}
          onClick={() => onNavigate(item.id)}
          title={item.label}
          className="group relative flex h-3 w-4 items-center text-left"
        >
          <span
            className={`block h-[3px] rounded-full transition-all ${
              index === last
                ? "w-4 bg-[var(--color-text)]"
                : index % 4 === 0
                  ? "w-3 bg-[var(--color-muted)]"
                  : "w-2 bg-[var(--color-border-strong)] group-hover:w-4 group-hover:bg-[var(--color-text-2)]"
            }`}
          />
          <span className="shell-card shell-elevated pointer-events-none absolute left-5 top-1/2 hidden w-72 -translate-y-1/2 px-3 py-2 text-[12px] leading-relaxed text-[var(--color-muted)] group-hover:block">
            <span className="line-clamp-3">{item.label}</span>
          </span>
        </button>
      ))}
    </nav>
  );
}
