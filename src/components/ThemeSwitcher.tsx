import { useEffect, useState } from "react";
import { Monitor, Sun, Moon } from "lucide-react";
import { getTheme, setTheme, subscribe, type Theme } from "../lib/theme";

const SEGMENTS: { value: Theme; label: string; Icon: typeof Monitor }[] = [
  { value: "system", label: "System", Icon: Monitor },
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
];

/** Codex-style compact segmented control: System / Light / Dark. */
export function ThemeSwitcher() {
  const [theme, setLocal] = useState<Theme>(getTheme);

  // Reflect external changes (other switchers, system-mode OS flips).
  useEffect(() => subscribe(setLocal), []);

  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className="inline-flex items-center gap-0.5 rounded-full p-0.5"
      style={{
        background: "var(--color-panel-2)",
        border: "1px solid var(--color-border)",
      }}
    >
      {SEGMENTS.map(({ value, label, Icon }) => {
        const active = theme === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={label}
            title={label}
            onClick={() => setTheme(value)}
            className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors"
            style={{
              background: active ? "var(--color-accent)" : "transparent",
              color: active ? "#fff" : "var(--color-text-2)",
            }}
            onMouseEnter={(e) => {
              if (!active) e.currentTarget.style.color = "var(--color-text)";
            }}
            onMouseLeave={(e) => {
              if (!active) e.currentTarget.style.color = "var(--color-text-2)";
            }}
          >
            <Icon size={13} strokeWidth={2} />
            <span className="text-[12px]">{label}</span>
          </button>
        );
      })}
    </div>
  );
}
