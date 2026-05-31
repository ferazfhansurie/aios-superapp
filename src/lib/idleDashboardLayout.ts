export type IdleWidgetId =
  | "pulse"
  | "projects"
  | "quick"
  | "dev"
  | "pinned"
  | "apps"
  | "device"
  | "fleet";

export interface IdleWidgetConfig {
  id: IdleWidgetId;
  visible: boolean;
}

export const DEFAULT_IDLE_WIDGETS: IdleWidgetConfig[] = [
  { id: "pulse", visible: true },
  { id: "projects", visible: true },
  { id: "quick", visible: true },
  { id: "dev", visible: true },
  { id: "pinned", visible: true },
  { id: "apps", visible: true },
  { id: "device", visible: true },
  { id: "fleet", visible: true },
];

export const IDLE_WIDGET_LABELS: Record<IdleWidgetId, string> = {
  pulse: "pulse",
  projects: "projects",
  quick: "quick actions",
  dev: "dev pulse",
  pinned: "pinned",
  apps: "apps",
  device: "device",
  fleet: "fleet",
};

const knownIds = new Set<IdleWidgetId>(DEFAULT_IDLE_WIDGETS.map((w) => w.id));

export function normalizeIdleWidgets(input: unknown): IdleWidgetConfig[] {
  const seen = new Set<IdleWidgetId>();
  const fromInput = Array.isArray(input)
    ? input.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const id = (item as { id?: unknown }).id;
        if (typeof id !== "string" || !knownIds.has(id as IdleWidgetId)) return [];
        if (seen.has(id as IdleWidgetId)) return [];
        seen.add(id as IdleWidgetId);
        return [{ id: id as IdleWidgetId, visible: (item as { visible?: unknown }).visible !== false }];
      })
    : [];

  return [
    ...fromInput,
    ...DEFAULT_IDLE_WIDGETS.filter((widget) => !seen.has(widget.id)),
  ];
}

export function moveIdleWidget(
  widgets: IdleWidgetConfig[],
  id: IdleWidgetId,
  delta: -1 | 1,
): IdleWidgetConfig[] {
  const index = widgets.findIndex((widget) => widget.id === id);
  if (index < 0) return widgets;
  const to = Math.max(0, Math.min(widgets.length - 1, index + delta));
  if (to === index) return widgets;
  const next = [...widgets];
  const [widget] = next.splice(index, 1);
  next.splice(to, 0, widget);
  return next;
}

export function toggleIdleWidget(
  widgets: IdleWidgetConfig[],
  id: IdleWidgetId,
): IdleWidgetConfig[] {
  return widgets.map((widget) =>
    widget.id === id ? { ...widget, visible: !widget.visible } : widget,
  );
}
