# chat and history performance architecture

date: 2026-07-11
status: approved design, pending implementation plan
scope: aios supershell at `/Users/firazfhansurie/Repo/firaz/aios/shell`

## objective

make chatpane and history pane remain responsive as transcript volume and session length grow. optimize actual i/o, parsing, serialization, react rendering, and reattach behavior rather than masking lag with loading indicators.

the migration must preserve existing transcript files as the source of truth and coexist with the current uncommitted codex steer/requeue work.

## evidence

the current local transcript corpus contains roughly 2,268 jsonl files totaling about 1.53 gb. individual transcripts reach 77 mb.

the current history flow performs a batch transcript-existence check and then calls `read_chat_transcript` for many resume rows. those calls read and parse complete transcripts merely to decide whether a history item contains messages. other session discovery paths periodically rescan codex and claude transcript trees and derive previews from full files.

chat token deltas are already coalesced with `requestanimationframe`, but each flush can still clone the complete turns array, rebuild transcript blocks, and rerender a non-virtualized transcript. run-event persistence also duplicates high-frequency token state and serializes it into localstorage.

t3code demonstrates useful patterns at commit `f61fa9499d96fee825492aba204593c37b27e0cb`: warm cached thread snapshots with sequence-cursor catchup, virtualized timelines with explicit scroll anchoring, reference-stable row projections, snapshot-plus-delta terminal streams, bounded buffers, and operation-specific concurrency.

## chosen architecture

### 1. native transcript index

add a disposable native index for transcript metadata. sqlite is preferred because it supports durable incremental updates, indexed filtering, pagination, and schema migrations without loading the dataset into the webview.

each indexed transcript records at least:

- stable session id and engine
- source path
- source modification time and byte size
- created and updated timestamps
- working directory and project identity
- title or latest user-message preview
- message and turn counts
- sparse byte offsets for paginated turn retrieval
- index schema version and last successful parse position

the jsonl transcript remains authoritative. deleting or rebuilding the index must never modify source transcripts.

### 2. incremental indexing

startup serves cached history immediately. reconciliation runs off the ui thread with bounded concurrency and compares path, modification time, and size before reading content.

new files are indexed from byte zero. appended files resume from the last valid byte offset. replaced, truncated, or invalidated files are rebuilt individually. unchanged files receive metadata checks only.

the indexer extracts previews and sparse turn offsets in one pass. it does not maintain a separate full transcript copy.

history refresh becomes event-driven after chat completion, transcript append, rename, or deletion. native watcher indexing continues while the webview is hidden to preserve freshness. hidden state suppresses frontend queries, polling, and rendering only. a low-frequency safety reconciliation must not parse unchanged files.

### 3. preserve pane history and index chat metadata separately

the general `HistoryPane` remains backed by `pane-history.json` and keeps its mixed browser, terminal, files, chat, ordering, reopen, remove, and clear semantics. the transcript index does not replace that store. chat rows join `PaneHistoryItem.resumeId` to indexed metadata only for validation and preview enrichment. clearing pane history never deletes an indexed session or transcript.

the `/resume` picker uses a separate indexed-session query with cursor pagination. filtering, grouping, and search execute against indexed metadata; pane-history ordering is not session-catalog ordering.

mounting history must issue no `read_chat_transcript` calls. existence and non-empty state come directly from indexed counts. collapsed groups render only a preview slice while retaining the selected session if necessary.

responses carry a generation id or request key. results from an earlier query cannot overwrite a newer filter, page, or selected session.

### 4. paginated transcript api

opening a session requests the newest page of turns and the cursor for the preceding page. the native layer uses sparse offsets to seek near the requested region, reads a bounded byte range, and parses only the needed turns.

scrolling upward loads older pages. after insertion, the client restores the previous visual anchor using the first visible stable row id and its offset. malformed records are skipped with diagnostics; valid surrounding turns remain available.

### 5. settled transcript and streaming tail

chatpane separates immutable settled turns from the active streaming tail.

within one animation frame, compatible text or reasoning deltas are concatenated and applied once. settled row objects retain reference identity. markdown parsing for settled content is cached by stable content identity; only the active tail is reparsed while it changes.

settled rows use a virtualized timeline with stable keys, estimated sizes, measured-size correction, explicit bottom-follow behavior, and visible-position preservation. browser overflow anchoring must not compete with application anchoring.

the user remains pinned only while already near the bottom. when reading earlier content, streaming must not move the viewport; a jump-to-latest control reports unseen updates.

### 6. compact run persistence and race-free reattach

do not persist each token delta as a separate event. retain structural lifecycle events and aggregated message or reasoning spans. persistence moves away from synchronous localstorage toward the native store or an asynchronous browser store, with writes on idle and durable turn boundaries.

each chat event receives a monotonically increasing per-run sequence under the run-state mutex and enters the bounded ring before publication. snapshot projection and its high-water sequence are captured atomically while a provisional subscriber is bound. transport occurs after releasing the mutex. retained and provisionally captured events above the high-water mark are drained before the subscriber is atomically promoted to live delivery.

clients apply sequences idempotently. if the next required sequence was evicted, the backend returns `resync_required` and supplies a fresh snapshot. locks cover snapshot/cursor capture and subscriber promotion, never ipc transport.

compaction preserves semantic control events. `codex_steer_requeued` must precede terminal `result`; queued messages retain stable occurrence ids, pending-steer state, and duplicate-text identity across detach and reattach.

## normalization, identity, and discovery

claude and codex use separate versioned adapters that emit one normalized turn schema. stable row ids derive from engine, canonical source identity, source record identity when present, byte offset, and variant, never display text. sparse checkpoints store parser version, adapter state, last complete newline, row ordinal, and source fingerprint. partial trailing lines remain uncommitted; malformed complete records create deterministic skipped-record markers.

page cursors include source fingerprint and index generation. append-only growth preserves prior row ids. replacement, truncation, parser change, or source change returns `page_resync_required`. each query reads one committed generation.

the source key is `(engine, canonical_config_root, canonical_path)` and logical session key is `(engine, canonical_config_root, session_id)`. discovery covers active and legacy codex roots, claude project roots, and configured account roots. symlinks are canonicalized within approved roots. active configured roots outrank legacy roots, then the newest valid fingerprint wins; duplicates remain diagnosable aliases. aios-curated titles/activity remain overlay fields with precedence over extracted previews.

## migration, freshness, and query semantics

schema upgrades and corruption recovery build a candidate database beside the active database. the active index remains readable until the candidate passes integrity checks and is atomically promoted. failed candidates leave the prior index untouched.

on first build, mixed pane history remains usable from `pane-history.json`. the `/resume` picker may use a byte- and file-count-bounded legacy query, never unbounded full reads; budget exhaustion returns partial results plus indexing progress.

native watchers cover approved roots and coalesce create, append, replace, rename, and delete events. overflow/failure triggers metadata-only reconciliation and backoff restart. a periodic metadata-only scan repairs missed external writes and parses only changed fingerprints.

session pagination uses activity timestamp descending, then engine, config-root identity, and session id as deterministic keyset tie-breakers. search uses sqlite fts5 across title, latest-user preview, cwd, and project label, with escaped prefix-token queries and bm25 followed by the activity keyset.

## supported capability bundles

- v1: legacy api and renderer
- v2a: indexed catalog with legacy transcript open
- v2b: indexed catalog plus paginated api and compatible client
- v3: v2b plus virtualized settled transcript and streaming tail
- v4: v3 plus sequenced snapshot/cursor reattach

frontend and backend negotiate capabilities at startup. persisted index, cursor, snapshot, and cache formats are versioned. newer payloads are never sent to an older client. downgrade ignores incompatible caches and uses the last compatible index or bounded fallback.

## migration sequence

1. add reproducible synthetic benchmarks and correctness contracts.
2. implement the versioned native index and background reconciler while retaining the old read path as fallback.
3. switch the `/resume` picker to the indexed catalog; join chat rows in the mixed history pane to indexed validation/enrichment while preserving its existing store and semantics; remove redundant transcript reads and unconditional frontend polling.
4. add paginated transcript retrieval and upward-load scroll anchoring behind a feature flag.
5. introduce the settled-transcript/streaming-tail model, delta aggregation, and timeline virtualization.
6. compact run persistence and replace raw reattach replay with snapshot plus cursor.
7. remove fallback paths only after latency, correctness, and migration gates pass.

## failure and recovery behavior

- index corruption or schema mismatch automatically creates a fresh index and rebuilds in the background.
- rebuild progress is observable and does not block cached or fallback history access.
- source files are never deleted, rewritten, or moved by index recovery.
- missing files remove or tombstone only their index rows after reconciliation.
- malformed jsonl records emit bounded diagnostics and allow partial indexing.
- pagination and reattach requests are generation-scoped to reject stale responses.
- cancellation and pane changes stop unnecessary parsing work where practical.
- index writes use transactions; an interrupted update leaves the last valid index state readable.

## performance contracts

- warm history opens in under 100 ms from invoke start to committed rows and performs no transcript parsing.
- history mount performs one lightweight indexed query and zero full transcript reads.
- opening the newest page of a synthetic 50 mb transcript renders in under 300 ms on the development machine.
- with 5,000 settled blocks and a 30 hz tail, frame time is under 16.7 ms p95 and 33.4 ms p99, with no main-thread task over 100 ms.
- input-to-next-paint p95 remains under 50 ms during a controlled 10,000-delta replay.
- hidden panes perform no frontend history queries, polling, or rendering work; bounded native watcher indexing continues.
- reattach work is bounded by snapshot size and post-cursor events, not total historical events.
- an incremental append becomes queryable within 500 ms p95 after its filesystem event settles.
- indexer peak memory stays under 256 mb above idle; index size stays under 15 percent of synthetic source bytes.
- cancellation stops additional reads within 100 ms p95 after the current bounded record read.

the benchmark manifest records hardware, os, build mode, webview, fixture seed/composition, cache state, and timing boundaries. gates use 20 measured warm runs after 3 discarded warmups and report median, p95, p99, variance, peak memory, bytes read, and long tasks. fixtures use temporary synthetic homes so private transcript content never enters traces or snapshots.

## test plan

### native tests

- first index build, append-only update, truncation, replacement, deletion, and schema migration
- malformed and partially written jsonl recovery
- sparse-offset pagination across claude and codex transcript formats
- ordering, filtering, project grouping, and cursor stability
- transactional recovery after interrupted index writes
- snapshot/cursor reattach ordering, deduplication, and buffer bounds
- cursor-too-old recovery and concurrent snapshot-to-live handoff
- steer-requeue ordering before result, stable queue identity, duplicate text, and pending-steer detach/reattach

### frontend tests

- history mount invokes indexed listing and never full transcript reads
- stale query generations cannot replace current results
- upward pagination preserves the visible row and pixel offset
- adapter row identity, partial lines, malformed records, append consistency, and cursor invalidation
- bottom-follow pauses and resumes correctly
- settled rows preserve reference identity during tail updates
- streaming frame aggregation is semantically equivalent to sequential deltas
- hidden panes do not trigger frontend history refresh work

### performance and integration tests

- history benchmark with 200 rows and 100 resumed sessions
- transcript benchmarks at 1 mb, 10 mb, and 50 mb
- playwright typing latency with 1,000 and 5,000 settled blocks
- controlled 10,000-delta stream measuring react commits, long tasks, and dropped frames
- migration test against copied fixtures from both engine formats
- full frontend unit, lsp, rust, build, and e2e suites

the package test surface should be corrected so `paneBus.test.ts`, `taskWorkspace.test.ts`, `TaskActivity.test.ts`, and rust tests are included in normal ci gates.

## rollout and observability

ship the compatible capability bundles in order. record bounded diagnostics for index duration, files examined, files parsed, bytes read, history-query latency, page latency, stream-frame duration, watcher recovery, and reattach payload size.

do not record transcript text in performance telemetry.

promote each stage when correctness tests pass and its latency contract is met on synthetic fixtures. retain a rebuild-index control for recovery and debugging.

## constraints and non-goals

- preserve the five existing uncommitted steer/requeue source edits.
- avoid unrelated visual redesign of chatpane or history pane.
- do not migrate or rewrite transcript source files.
- do not add cloud synchronization to this performance pass.
- do not keep every session or transcript page resident indefinitely; use bounded retention.

## expected result

history becomes a metadata query rather than a transcript-parsing operation. opening a chat becomes a bounded page read rather than a full-file transfer. streaming work becomes proportional to the active tail and visible rows rather than total conversation size. reattach cost becomes proportional to new state since the cursor rather than the complete buffered event history.
