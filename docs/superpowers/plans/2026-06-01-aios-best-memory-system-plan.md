# aios best memory system plan

> status: deepdive plan. no app bundle build until planning passes are done.

## current system review

aios already has a real base:

- rust `memory.rs` resolves an obsidian-shaped markdown vault.
- `memory_graph` parses markdown frontmatter, `metadata.type`, wikilinks, and returns graph nodes/edges.
- `memory_file` is path-guarded to the vault.
- `memory_save` / `memory_delete` write markdown and maintain `MEMORY.md`.
- `MemoryPane` gives table + 3d graph + reader + inline editor.
- `DatabasePane` mounts memory vault as the first data source.
- settings exposes memory path and graph physics.
- dashboard/pulse show freshest memory focus.
- browser has pinned-site url memory separately through `browser-mem.ts`.

that is good as a vault/browser. it is not yet the best ai memory system.

## key gaps

### 1. memory is passive

memory exists in a pane, but chat/runs do not automatically retrieve, cite, update, or audit memories.

needed:
- memory hits shown in chat context
- memory attached before send
- memory used by model is visible
- memory updates suggested after runs

### 2. no memory tiers

all markdown notes are treated similarly. aios needs tiers:

- identity memory: firaz, preferences, voice, product philosophy
- project memory: repo conventions, architecture, active plans
- conversation memory: what this thread decided
- run memory: commands tried, failures, shipped commits
- pane memory: what each pane is for
- browser memory: page groups, research trails
- contact/client memory: people, whatsapp, crm, relationship context
- workflow memory: repeated successful procedures

### 3. no retrieval engine

search is string/filter/table. best memory needs ranked retrieval.

signals:
- exact text match
- type priority
- project/cwd match
- recency
- link degree
- explicit pin
- user-confirmed importance
- run success/failure relevance
- semantic embedding later

### 4. no provenance / trust

the app should know where a memory came from.

fields needed:
- source: user / ai suggestion / run summary / file / browser / whatsapp / imported
- created_at
- updated_at
- confidence
- last_used_at
- used_count
- related project/session/run ids
- supersedes / superseded_by

### 5. no memory write policy

ai should not silently write long-term memory.

policy:
- user-authored memory writes are direct.
- ai-suggested memory writes go to review queue.
- small obvious updates can be one-click accepted.
- dangerous/sensitive memory needs confirmation.
- every write has a diff and provenance.

### 6. graph is visual, not operational

3d graph is useful for exploration but not enough for daily work.

needed:
- memory inbox
- stale/conflict detector
- merge duplicates
- pin to project
- attach to chat
- “why is this memory relevant?”
- “forget this”

## target architecture

### memory store

keep markdown vault for human portability, but add a structured index.

v1:
- markdown files remain source of truth.
- rust builds an in-memory index on `memory_graph`.
- add sidecar `.aios-memory-index.json` or sqlite later for derived metadata.

v2:
- sqlite index for fast search/retrieval/provenance.
- markdown sync remains export/source view.

### memory schema

frontmatter should grow to:

```yaml
---
name: aios_more_better_philosophy
description: firaz wants more and better until density hurts, then invent a stronger primitive.
metadata:
  type: preference
  scope: global
  source: user
  confidence: high
  projects: []
  sessions: []
  tags: [product, ux, philosophy]
  created_at: 2026-06-01T00:00:00Z
  updated_at: 2026-06-01T00:00:00Z
  last_used_at:
  used_count: 0
---
```

types:
- `identity`
- `preference`
- `project`
- `plan`
- `workflow`
- `contact`
- `client`
- `research`
- `decision`
- `failure`
- `artifact`
- `browser`
- `pane`
- `reference`

scopes:
- `global`
- `project`
- `conversation`
- `run`
- `pane`
- `contact`
- `browser_group`

## features to build

### 1. memory retrieval service

files:
- create `src/lib/memorySearch.ts`
- modify `src-tauri/src/memory.rs`
- modify `src/lib/memory.ts`

commands:
- `memory_search(query, cwd, session_id, limit)`
- `memory_context(cwd, session_id, pane_keys, query)`
- `memory_mark_used(memory_id, run_id)`

ranking v1:
- title/id/description/body text match
- cwd/project path match
- type priority
- recency from file mtime
- link degree

acceptance:
- chatpane can ask for top memories before send.
- retrieval returns reason strings, not just nodes.

### 2. composer memory context

files:
- modify `src/components/ChatPane.tsx`
- create `src/components/MemoryContextPicker.tsx`

ui:
- memory chip above composer: `3 memories`
- click opens picker
- search memories
- attach/detach memory
- show why selected
- preview markdown

acceptance:
- user sees which memories will be sent.
- memory context is explicit, not hidden prompt magic.

### 3. thread memory rail

files:
- modify future `ThreadRightRail.tsx`
- create `src/components/MemoryRailTab.tsx`

tabs content:
- used memories
- suggested memories
- attached memories
- new facts detected
- stale/conflicting memories

acceptance:
- every run shows memory inputs and memory outputs.

### 4. memory write review queue

files:
- create `src/lib/memorySuggestions.ts`
- create `src/components/MemoryReviewQueue.tsx`
- modify `src-tauri/src/memory.rs`

flow:
- ai proposes memory after a run.
- user sees diff/add card.
- approve / edit / reject / merge.
- approved writes markdown.

acceptance:
- no silent long-term writes.
- every memory write has provenance.

### 5. automatic run summarization

after each completed run, generate:
- what was decided
- files changed
- commands/tests run
- failures and fixes
- new preference learned
- workflow worth saving

not all become long-term memory. they become suggestions first.

acceptance:
- successful repeated actions can become workflow memory.
- failures can become “do not repeat” memory.

### 6. project memory

project memory should surface automatically by cwd/repo.

examples:
- repo architecture
- test commands
- build commands
- current plans
- style rules
- known gotchas
- branch/worktree rules

acceptance:
- opening a repo gives chatpane project memory chips.
- project cockpit shows memory for that repo.

### 7. pane memory

each pane can have purpose and state.

examples:
- “build terminal”
- “research browser”
- “main editor”
- “oracle session”

fields:
- pane key
- pane type
- purpose
- cwd/url/path
- last used
- linked conversation

acceptance:
- ai can understand current layout.
- pane purpose persists across relaunch.

### 8. browser/research memory

browser groups should produce research memory.

features:
- save page summary
- save source url
- save screenshot/artifact
- attach browser group to chat
- remember research trail per project/conversation

acceptance:
- browser is not just navigation; it feeds memory and artifacts.

### 9. conflict / stale detector

memory should police itself.

detect:
- duplicate titles
- contradictory preference notes
- stale project commands
- broken wikilinks
- orphan notes
- notes never used

acceptance:
- memory pane has health/status.
- user can merge/forget stale memory.

### 10. memory graph v2

graph should become operational:
- filter by scope/type/project
- show usage intensity
- show stale nodes
- show active project cluster
- right-click actions: attach, edit, forget, merge, open source
- layout presets: global map, project map, conversation map

acceptance:
- graph helps decide what memory matters now.

## implementation order

1. add richer memory metadata parser/writer.
2. add memory search/retrieval command with reason strings.
3. add composer memory picker/chips.
4. add memory run events: `memory.attached`, `memory.used`, `memory.suggested`, `memory.written`, `memory.rejected`.
5. add thread rail memory tab.
6. add memory suggestion queue.
7. add project/pane/browser memory stores.
8. add stale/conflict detector.
9. upgrade graph v2.
10. add embeddings/sqlite index after the v1 ranked retrieval proves useful.

## best-system principle

memory must be visible, inspectable, editable, and attributable.

bad memory system:
- hidden prompt stuffing
- silent writes
- no provenance
- impossible to forget
- no clue why the model remembered something

best memory system:
- “what i know”
- “why i know it”
- “where it came from”
- “when i used it”
- “should i keep/update/delete it?”
- “attach this to the next run”

## immediate next slice

build `memory_search` + composer memory chips first.

why:
- low risk
- uses existing markdown vault
- immediately makes chatpane smarter
- does not require embeddings/sqlite yet
- sets up right rail and runevent integration cleanly
