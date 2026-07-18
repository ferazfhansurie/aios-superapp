# Contributing to AIOS

Thanks for wanting to improve AIOS. Keep changes focused, testable, and easy to
review.

## Contribution workflow

AIOS uses a fork-first workflow so the upstream repository stays clean:

1. Fork `ferazfhansurie/aios-superapp` to your GitHub account.
2. Create a short-lived branch in your fork from the latest `master`.
3. Use a descriptive name such as `feat/add-pane`, `fix/history-order`, or
   `docs/setup-guide`.
4. Push the branch to your fork and open a pull request into upstream `master`.
5. Delete the branch after the pull request is merged or closed.

Even maintainers should use a fork for feature work. The upstream repository
keeps only the protected `master` branch unless a maintained release line is
introduced later. Do not create personal or long-lived development branches in
upstream.

## Dev setup

```bash
pnpm install
pnpm tauri dev
```

You'll need Rust (stable, via [rustup](https://rustup.rs)), Node 20+, pnpm, and
the macOS Xcode command-line tools. Other platforms are not officially
supported; community ports should start in contributor forks.

Before opening a PR:

```bash
pnpm build              # type-check + build the frontend (tsc + vite)
pnpm test:router
pnpm test:codex-adapter
pnpm test:chatpane
pnpm test:lsp
pnpm test:cfo
cargo fmt --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
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
- Open one PR per issue or independently reviewable change.
- Rebase or merge the latest upstream `master` before requesting final review.
- Match the surrounding style; the Rust modules are heavily commented, so
  comment the *why*.
- Don't add dependencies casually — the dependency list is intentionally lean.
- Describe what you changed and how you tested it.

## License

By contributing you agree your work is licensed under the [MIT License](./LICENSE).
