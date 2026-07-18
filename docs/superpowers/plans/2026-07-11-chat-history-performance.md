# Chat And History Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** replace unbounded transcript discovery/reads and full-history streaming work with an indexed, paginated, reference-stable chat path.

**Architecture:** a native sqlite transcript catalog owns metadata, normalized turn checkpoints, and keyset queries while source jsonl remains authoritative. the frontend keeps mixed pane history separate, consumes indexed chat metadata, loads transcript pages, and renders immutable settled rows apart from the active stream tail. reattach evolves behind capability negotiation to a sequenced snapshot/cursor handshake.

**Tech Stack:** rust, rusqlite, tauri 2, react 19, typescript, node test runner, playwright.

---

## file map

- create `src-tauri/src/chat_index.rs`: sqlite schema, source identity, reconciliation, indexed catalog, and paginated turn queries.
- create `src-tauri/src/chat_index/adapters.rs`: versioned claude/codex jsonl normalization and checkpoint state.
- create `src-tauri/src/chat_index/tests.rs`: synthetic transcript/index/migration/pagination tests.
- modify `src-tauri/Cargo.toml` and `src-tauri/Cargo.lock`: add the cross-platform `notify` watcher dependency.
- modify `src-tauri/src/chat.rs`: delegate catalog/transcript reads, add page and capability commands, preserve bounded fallback, add sequenced reattach.
- modify `src-tauri/crates/aios-chat-core/src/session.rs`: sequenced ring, snapshot/cursor handoff, and eviction recovery while preserving imported dirty work.
- modify `src-tauri/crates/aios-chat-core/src/codex_rpc.rs`: preserve steer occurrence identity and requeue/result ordering while preserving imported dirty work.
- modify `src-tauri/src/lib.rs`: register new module and commands.
- modify `src/lib/chat.ts`: typed catalog/page/capability clients.
- modify `src/lib/paneHistory.ts`: validate chat rows from one indexed batch without transcript reads.
- modify `src/components/HistoryPane.tsx`: retain mixed pane-history semantics and join indexed chat metadata.
- create `src/lib/transcriptPages.ts`: generation-safe page reducer and stable row identities.
- create `src/lib/transcriptPages.test.ts`: pagination, stale generation, and anchor contracts.
- modify `src/components/ChatPane.tsx`: paginated resume, settled-tail split, frame aggregation, and reattach sequence handling.
- create `src/lib/virtualTranscript.ts` and `src/lib/virtualTranscript.test.ts`: pure stable identity, window geometry, and follow/pause contracts runnable by the node test runner.
- create `src/components/chat/VirtualTranscript.tsx`: react rendering shell covered by playwright integration tests.
- modify `src/lib/runEvents.ts`: aggregate semantic spans rather than persist per-token events.
- create `src/lib/runEventStore.ts` and `src/lib/runEventStore.test.ts`: asynchronous indexeddb persistence with versioning, migration, and memory fallback.
- modify `src/lib/terminalOutputPump.ts`: reuse bounded snapshot/suffix concepts where applicable.
- create `scripts/bench-chat-history.mjs`: reproducible synthetic history/transcript/stream benchmark.
- modify `package.json` and ci workflow: include omitted frontend/rust tests and benchmark smoke gates.

### task 0: isolate and preserve the dirty steer baseline

- [ ] create a global worktree branch from `652d48a` so no project-local ignore change is needed.
- [ ] export exactly the five pre-existing dirty source diffs from the original tree and apply them in the worktree.
- [ ] commit those imported diffs alone as `wip(chat): preserve steer requeue baseline`, recording the original diff hash in the commit body; do not include png/zip artifacts.
- [ ] run the existing focused chat and rust tests to verify the imported baseline before performance work.
- [ ] use path-scoped staging for every later commit and verify `git diff <baseline> --` before each task review.

### task 1: baseline harness and fixtures

- [ ] add synthetic 1 mb, 10 mb, and sparse 50 mb claude/codex jsonl fixture generators under temporary homes.
- [ ] add benchmark manifest output for hardware, os, build mode, seed, cache state, iterations, median/p95/p99, memory, and bytes read.
- [ ] add harness self-tests for deterministic fixture sizes/seeds and metric calculation; observe red locally, implement the harness, and commit only after green.
- [ ] commit the green harness as `test: add chat history performance harness`.

### task 2: versioned native transcript index

- [ ] write failing rust tests for schema creation, canonical source identity, unchanged metadata detection, duplicate logical ids, and atomic side-by-side schema promotion.
- [ ] implement `chat_index.rs` with sqlite tables for sources, sessions, checkpoints, normalized rows, aliases, overlays, and schema metadata.
- [ ] implement canonical approved-root discovery and deterministic active-root/legacy-root precedence.
- [ ] implement schema/source registration and metadata fingerprint comparison without transcript parsing; never rewrite source jsonl.
- [ ] run `cargo test --manifest-path src-tauri/Cargo.toml chat_index` and make it pass.
- [ ] commit as `feat(chat): add incremental transcript index`.

### task 3: normalized adapters and paginated native reads

- [ ] write failing tests for claude/codex stable row ids, sparse checkpoints, partial trailing lines, append consistency, malformed records, replacement invalidation, and newest/older keyset pages.
- [ ] implement engine-specific adapters emitting the shared normalized turn schema and deterministic skipped-record markers.
- [ ] implement bounded parse/checkpoint reconciliation, append resume, truncation/replacement rebuild, and parser-version invalidation using the adapters.
- [ ] implement `list_indexed_chat_sessions`, `read_chat_transcript_page`, index status, rebuild, and capability commands.
- [ ] return `page_resync_required` for incompatible source fingerprints or generations.
- [ ] register commands in `lib.rs`; retain a byte/file-budgeted legacy fallback for first build only.
- [ ] add the `notify` crate in `src-tauri/Cargo.toml`, then implement native watcher coalescing and metadata-only safety reconciliation before any frontend polling is disabled; test append, rename, delete, overflow, failure restart, and approved-root boundaries.
- [ ] run focused rust tests and commit as `feat(chat): add indexed transcript pagination`.

### task 4: remove history hot-path full reads

- [ ] write failing typescript tests proving mixed pane-history ordering/reopen/remove/clear behavior is unchanged and chat validation performs one indexed batch query with no transcript-body calls.
- [ ] update `chat.ts` types and `paneHistory.ts` validation to consume indexed metadata.
- [ ] update `HistoryPane.tsx` to enrich chat rows without replacing `pane-history.json` or affecting non-chat entries.
- [ ] migrate `/resume` discovery to indexed keyset pages and generation-safe search.
- [ ] after watcher tests pass, pause frontend polling while hidden; native watcher indexing and bounded safety reconciliation continue.
- [ ] run frontend history tests plus `pnpm test:chatpane`; commit as `perf(history): eliminate transcript reads on mount`.

### task 5: paginated chat resume and scroll anchoring

- [ ] write failing reducer tests for newest-first load, older-page prepend, stale generation rejection, duplicate suppression, and anchor preservation.
- [ ] implement `transcriptPages.ts` with stable row maps, page cursors, generation ids, and resync handling.
- [ ] add v2a/v2b capability negotiation and version-skew tests; legacy clients keep full transcript open and pagination payloads are sent only after v2b negotiation.
- [ ] behind negotiated v2b, update `ChatPane.tsx` resume to request the newest bounded page and fetch older pages near the top; retain tested fallback.
- [ ] restore the first visible stable row and pixel offset after prepend.
- [ ] add loading, partial-record diagnostic, rebuild, and cursor-resync states without blocking usable content.
- [ ] run focused tests and e2e resume coverage; commit as `perf(chat): paginate transcript resume`.

### task 6: settled transcript, streaming tail, and virtualization

- [ ] write failing tests proving settled row references and transcript render counts remain unchanged during tail-only deltas.
- [ ] aggregate compatible deltas into one update per animation frame before invoking the reducer.
- [ ] separate immutable settled rows from the active mutable text/reasoning tail and cache settled markdown by stable content identity.
- [ ] implement and node-test pure window geometry/reference/anchor logic in `src/lib/virtualTranscript.ts`.
- [ ] implement `VirtualTranscript.tsx` with stable keys, measured sizes, overscan, bottom-follow threshold, paused anchoring, and jump-to-latest unseen count; cover DOM behavior in Playwright and wire pure tests into `test:chatpane` in this task.
- [ ] ensure browser overflow anchoring is disabled for this surface and application anchoring owns position.
- [ ] run 1k/5k block typing and 10k-delta benchmarks; require the spec thresholds.
- [ ] commit as `perf(chat): virtualize settled transcript`.

### task 7: compact persistence and race-free reattach

- [ ] write failing rust/typescript tests for atomic sequence assignment, concurrent snapshot/live handoff, duplicates, cursor eviction, `resync_required`, and reconnect.
- [ ] modify `aios-chat-core/src/session.rs` for per-run monotonically sequenced ring events and atomic snapshot/high-water/provisional-subscriber handoff; integrate rather than replace the imported dirty changes.
- [ ] modify `codex_rpc.rs` and `chat.rs` to preserve steer occurrence identity and transport outside locks; path-scope every commit so imported baseline is not accidentally rewritten.
- [ ] compact token spans while preserving semantic events and durable turn boundaries.
- [ ] implement versioned asynchronous indexeddb persistence in `runEventStore.ts`, migrate legacy localstorage once, write on idle/durable turn boundaries, and retain a bounded in-memory fallback when indexeddb is unavailable.
- [ ] test migration, downgrade/version mismatch, write coalescing, failure fallback, and absence of per-token synchronous localstorage writes.
- [ ] explicitly test `codex_steer_requeued` before `result`, duplicate-text queue identity, and pending steer across detach/reattach.
- [ ] negotiate v1-v4 capabilities so legacy clients never receive snapshot/page payloads.
- [ ] run chat-core, tauri, and frontend lifecycle suites; commit as `perf(chat): add sequenced snapshot reattach`.

### task 8: watcher, rollout gates, and full verification

- [ ] verify watcher recovery and freshness gates from task 3 under the full integration workload.
- [ ] add telemetry for index duration, files/bytes parsed, query/page latency, watcher recovery, stream-frame duration, and reattach size without transcript text.
- [ ] correct package/ci test coverage to include pane bus, task workspace, task activity, both rust suites, build, and e2e.
- [ ] run `pnpm test:chatpane`, `pnpm test:lsp`, omitted node tests, both cargo suites, `pnpm build`, benchmark smoke, and `pnpm test:e2e`.
- [ ] compare benchmark results to every design threshold; fix regressions before completion.
- [ ] update changelog and commit as `feat(chat): ship indexed low-lag chat history`.

## execution constraints

- preserve all pre-existing dirty changes in `codex_rpc.rs`, `session.rs`, `chat.rs`, `ChatPane.tsx`, and `Composer.tsx`; inspect and integrate rather than overwrite.
- use a dedicated worktree or carefully isolate commits when overlap makes a worktree impractical.
- do not delete or rewrite user transcripts.
- keep migrations reversible until v4 verification passes.
