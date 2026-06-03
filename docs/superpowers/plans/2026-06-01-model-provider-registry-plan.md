# model provider registry implementation plan

## goal

make chatpane model-agnostic without making it dumb. codex subscription stays first-class; claude stays first-class; opencode/openrouter/ollama become fallbacks and extensions.

## files

- create `src/lib/providers.ts`
- modify `src/lib/settings.ts`
- modify `src/lib/chat.ts`
- modify `src-tauri/src/chat.rs`
- modify `src/components/Settings.tsx`
- modify `src/components/ChatPane.tsx`

## provider tiers

1. local agentic cli: claude, codex, opencode, gemini-cli
2. byo api: openai, openrouter, ollama
3. free fallback: limited model with visible badge

## phases

1. provider registry types and capability matrix.
2. provider detection command.
3. settings provider/model picker.
4. codex app-server daemon upgrade.
5. opencode/openrouter model catalog.
6. byo api fallback.
7. secure key storage later.

## acceptance

- user can see available providers.
- unsupported controls hide or degrade honestly.
- codex terminal-grade config remains synced.
- chatpane can continue working when one provider is unavailable.
