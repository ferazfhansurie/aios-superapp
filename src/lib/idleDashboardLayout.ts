export type IdleWidgetId =
  | "money"
  | "pulse"
  | "projects"
  | "quick"
  | "dev"
  | "pinned"
  | "apps"
  | "device"
  | "fleet";

export type IdleWidgetSize = "compact" | "standard" | "wide" | "hero";

export interface IdleWidgetConfig {
  id: IdleWidgetId;
  visible: boolean;
  size: IdleWidgetSize;
}

export const DEFAULT_IDLE_WIDGETS: IdleWidgetConfig[] = [
  { id: "money", visible: true, size: "hero" },
  { id: "pulse", visible: true, size: "hero" },
  { id: "projects", visible: true, size: "standard" },
  { id: "quick", visible: true, size: "compact" },
  { id: "dev", visible: true, size: "standard" },
  { id: "pinned", visible: true, size: "compact" },
  { id: "apps", visible: true, size: "wide" },
  { id: "device", visible: true, size: "standard" },
  { id: "fleet", visible: true, size: "compact" },
];

export const IDLE_WIDGET_LABELS: Record<IdleWidgetId, string> = {
  money: "sales agents",
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
const knownSizes = new Set<IdleWidgetSize>(["compact", "standard", "wide", "hero"]);
const sizeOrder: IdleWidgetSize[] = ["compact", "standard", "wide", "hero"];
const defaultSizeById = new Map(DEFAULT_IDLE_WIDGETS.map((widget) => [widget.id, widget.size]));

function normalizeSize(id: IdleWidgetId, value: unknown): IdleWidgetSize {
  return typeof value === "string" && knownSizes.has(value as IdleWidgetSize)
    ? (value as IdleWidgetSize)
    : defaultSizeById.get(id) ?? "standard";
}

export function normalizeIdleWidgets(input: unknown): IdleWidgetConfig[] {
  const seen = new Set<IdleWidgetId>();
  const fromInput = Array.isArray(input)
    ? input.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const id = (item as { id?: unknown }).id;
        if (typeof id !== "string" || !knownIds.has(id as IdleWidgetId)) return [];
        if (seen.has(id as IdleWidgetId)) return [];
        seen.add(id as IdleWidgetId);
        const widgetId = id as IdleWidgetId;
        return [{
          id: widgetId,
          visible: (item as { visible?: unknown }).visible !== false,
          size: normalizeSize(widgetId, (item as { size?: unknown }).size),
        }];
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

export function cycleIdleWidgetSize(
  widgets: IdleWidgetConfig[],
  id: IdleWidgetId,
): IdleWidgetConfig[] {
  return widgets.map((widget) => {
    if (widget.id !== id) return widget;
    const index = sizeOrder.indexOf(widget.size);
    const next = sizeOrder[(index + 1) % sizeOrder.length] ?? "standard";
    return { ...widget, size: next };
  });
}
