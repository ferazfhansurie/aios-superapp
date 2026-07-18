# codex 5.6 models, effort control, and active claude design

date: 2026-07-10
status: approved for implementation planning

## context

the shell chatpane currently exposes only `gpt-5.3-codex-spark` and `gpt-5.5`, renders model and effort as separate small dropdown pills, and assumes codex effort tops out at `xhigh`. the installed codex catalog now advertises three 5.6 models with model-specific effort capabilities:

- `gpt-5.6-sol`: low, medium, high, xhigh, max, ultra; default low
- `gpt-5.6-terra`: low, medium, high, xhigh, max, ultra; default medium
- `gpt-5.6-luna`: low, medium, high, xhigh, max; default medium

the shell also renders every configured claude account in the sidebar and chatpane. the terminal's active claude login can differ from stale configured multi-account entries. the shell should behave like codex: show and run only the account currently logged into the terminal.

## approved product decisions

1. add sol, terra, and luna as selectable codex models.
2. keep model and effort as separate composer pills.
3. replace the existing effort row menu with a codex-style stepped slider popover.
4. make effort stops and defaults model-aware.
5. show one claude usage source in the sidebar and chatpane: the terminal's active/default claude login. remove account switching from those surfaces.
6. keep the permission pill visible and separate.

## goals

- expose the three current codex 5.6 models with truthful labels and capabilities.
- match the codex effort popover's geometry and interaction while respecting the separate-pill decision.
- send `max` and `ultra` without folding them to `xhigh` when the selected model supports them.
- change codex effort without discarding the live thread.
- use the same default claude configuration as the terminal (`~/.claude`) and render one claude usage block.
- preserve the existing dirty working tree and all unrelated behavior.

## non-goals

- dynamically mirroring every future codex model from `model/list` in this change.
- combining model and effort into one trigger.
- hiding the permission control inside advanced settings.
- redesigning the full composer or transcript.
- deleting secondary claude credentials from disk; they simply stop appearing and stop being selectable in these surfaces.
- folding broader codex.app chatpane ideas into this patch; those are a separate audited backlog.

## model catalog design

extend `ChatModel` with optional capability metadata:

- `shortLabel`: compact composer label, such as `5.6 sol`.
- `supportedEfforts`: ordered effort ids allowed by the model.
- `defaultEffort`: the effort selected when the current value is unsupported.

register sol, terra, and luna at the top of the codex group. keep existing codex models as fallbacks. model selection continues through the current codex app-server route; the backend already forwards arbitrary model ids on `thread/start` and `turn/start`.

when switching models:

1. keep the current effort if the new model supports it.
2. otherwise select that model's advertised default.
3. persist model plus per-model effort so reopening the app restores the user's last valid combination.

## effort control design

the model pill stays unchanged as its own control. the effort pill remains next to it and shows the selected effort only.

opening the effort pill renders a portal popover modeled on the supplied codex reference:

- about 450 px wide when space allows, clamped to the viewport on narrow panes.
- approximately 170 px tall with a 24 px corner radius and quiet dark surface.
- `advanced` header with chevron and bolt icon.
- one large rounded track with evenly spaced stops.
- warm peach selected fill, dark remaining track, and a large white thumb.
- the selected effort remains legible in the separate trigger pill.

interaction requirements:

- click a stop to select it.
- click or drag anywhere on the track and snap to the nearest supported stop.
- arrow-left/down and arrow-right/up move one stop.
- home/end select the first/last supported stop.
- expose `role="slider"`, current value text, and min/max/current position to assistive technology.
- close on selection only for click-on-stop; dragging may remain open for rapid comparison.
- close on escape and outside click.

the slider derives stops from the selected model. sol and terra show six stops ending in `ultra`; luna shows five ending in `max`. older models use their declared capability list or the safe legacy list.

## codex effort data flow

the current `codex_effort` helper is stale: it folds `max` and `ultracode` to `xhigh`. update it to accept the advertised non-empty effort ids used by the registered model, including `max` and `ultra`.

changing effort in a live codex thread must not recreate the session. add a backend command that:

1. updates `ChatSession.effort`.
2. if a thread id already exists, sends codex app-server `thread/settings/update` with the new `effort`.
3. if the thread is still starting, stores the value so the next `turn/start` uses it.

the installed app-server schema explicitly supports `thread/settings/update` and describes `effort: "ultra"` as proactive multi-agent behavior. codex turns continue to send the selected effort on `turn/start` as a defensive source of truth.

claude retains its existing spawn-time effort behavior; the live-update path is codex-specific.

## active claude design

the terminal's plain `claude` command uses the default `~/.claude` configuration and is currently authenticated as the fhe/internettoo account. the shell must use that same source instead of a separate account selector.

changes:

- chat sessions pass no alternate `claudeAccount`, so rust spawns claude with the default config exactly like the terminal.
- remove chatpane polling and rendering of secondary claude account rows.
- remove the chatpane account-switch action and its local-storage selection.
- sidebar usage renders one claude block from the active/default usage source, with no gmail/fhe duplicate rows or login hints.
- the visible label is simply `claude`; fhe identity may appear in a tooltip if active-auth metadata is available, but it is not a second row.

secondary account credentials and the existing backend multi-account reader remain untouched unless they become provably unused in a later cleanup.

## error handling

- if model capability metadata is missing, show a safe legacy effort list and never send an unknown value.
- if a persisted effort is no longer supported, coerce it to the model default before starting or updating a session.
- if live `thread/settings/update` fails, keep the selected ui value, surface the backend error through diagnostics, and ensure the next turn still carries the stored effort.
- if claude usage is unavailable, hide the single usage block as today; do not resurrect secondary-account hints.
- no model or usage failure may block opening or typing in the composer.

## testing

follow red-green-refactor for each behavior.

frontend unit coverage:

- the catalog contains the three exact model ids and correct ordered capabilities/defaults.
- model changes preserve a supported effort and coerce unsupported effort to the advertised default.
- slider snapping, keyboard movement, and accessibility value helpers work for six-stop and five-stop models.
- persisted model/effort combinations restore only when valid.
- sidebar and chatpane selectors produce one claude usage source and no secondary account rows.

rust coverage:

- `codex_effort` passes low, medium, high, xhigh, max, and ultra; rejects unknown/empty values.
- live codex effort updates write `thread/settings/update` when a thread exists and store the value when it does not.

integration verification:

- run chatpane tests, rust tests for `aios-chat-core` and shell chat code, typecheck, and production build.
- install the app with the supported local installer.
- visually compare the open effort popover against the codex reference at normal and narrow pane widths.
- smoke-test sol, terra, and luna model starts and confirm luna cannot select ultra.
- confirm sidebar and chatpane show one claude usage block and claude launches under the terminal's fhe login.

## rollout and rollback

this is a local app release with no data migration beyond additive settings fields. old settings without per-model effort data fall back to each model's default. rollback is reinstalling the timestamped previous app bundle created by `scripts/install-mac-local.sh`; stored settings remain backward-compatible.
