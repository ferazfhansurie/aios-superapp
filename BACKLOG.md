
## Cheap wins (2026-05-31)
- **Codex MCP-skip not honored → ~20s startup stall.** The chat pane passes
  `-c mcp_servers={}` to skip MCP for speed, but codex 0.135 ignores it — a
  PATH-stripped native run still stalled ~20s on figma + vercel MCP auth before
  the first token. That's a real slice of the per-turn jitter, separate from
  cold-start. Find the flag/config codex 0.135 actually respects to disable MCP
  servers per-invocation (or strip them from the codex config we hand it).

## Pending pickup (2026-05-30, deferred — firaz confirmed "YUP")
- **Per-pane top-right controls**: beyond just close (X), add maximize/fullscreen + hide/minimize + an options menu (duplicate, etc). DESIGN NOTE: maximize must lift `maximizedKey` to App (App.tsx) and set `active=false` on all NON-maximized panes — native browser webviews paint ABOVE html, so siblings must deactivate (shrink to 0) or they'll overpaint the maximized pane. ResizableGrid uses CSS grid (no transform), so a `fixed inset-2 z-30` on the maximized PaneCard escapes to viewport cleanly. Keep all panes mounted (don't unmount → webview/terminal state loss). Header lives at PaneCard ~line 1310.
