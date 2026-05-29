# Contributing to Cockpit

Thanks for wanting to hack on Cockpit. It's small on purpose — keep it that way.

## Dev setup

```bash
pnpm install
pnpm tauri dev
```

You'll need Rust (stable, via [rustup](https://rustup.rs)), Node 18+, and pnpm.
On macOS the Tauri prerequisites come with the Xcode command-line tools.

Before opening a PR:

```bash
pnpm build              # type-check + build the frontend (tsc + vite)
cargo fmt --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml
```

## Project layout

```
src/            React + TypeScript frontend
  components/     one file per pane
  lib/            Tauri-invoke wrappers + pane bus
src-tauri/      Rust (Tauri v2) backend
  src/            one module per capability; lib.rs registers commands
```

The rule of thumb: **one pane = one frontend component + one backend module +
one lib wrapper.** Backend modules expose `#[tauri::command]` functions; the
frontend never touches the OS directly, it goes through `src/lib/*`.

## Adding a pane

1. **Backend** — add a `src-tauri/src/<feature>.rs` module exposing
   `#[tauri::command]` functions. Register them in `lib.rs`'s
   `invoke_handler`. Long-running output should stream over a Tauri Channel
   (see `pty.rs` / `chat.rs` for the pattern).
2. **Frontend lib** — add `src/lib/<feature>.ts` that wraps the commands with
   `invoke(...)` and types the responses.
3. **Component** — add `src/components/<Feature>Pane.tsx` and wire it into the
   deck. Reuse the existing pane chrome and theming.
4. **Graceful degradation** — never panic and never assume AIOS infra is
   present. If tmux / `claude` / a vault is missing, return empty, not an error.
   Make machine-specific paths env-overridable (see `AIOS_*` vars in the README).

## PR etiquette

- Keep PRs focused — one pane or one fix at a time.
- Match the surrounding style; the Rust modules are heavily commented, so
  comment the *why*.
- Don't add dependencies casually — the dependency list is intentionally lean.
- Describe what you changed and how you tested it.

## License

By contributing you agree your work is licensed under the [MIT License](./LICENSE).
