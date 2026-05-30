/**
 * Provider registry — the spine of model-agnostic chat.
 *
 * AIOS chat is no longer hardwired to the local `claude` CLI. A "provider" is
 * one way to reach a model, in one of three tiers:
 *
 *   tier 1 — AGENTIC CLI (`kind: "cli"`): a real coding-agent binary on PATH
 *            (claude / codex / gemini / opencode). Full power — tool-use,
 *            approvals, streaming. The binary speaks its own stream protocol;
 *            the rust side normalizes it to the shared ChatEvent shape.
 *   tier 2 — NATIVE API (`kind: "api"`): BYO key, direct HTTP/SSE
 *            (openai / openrouter / ollama). Works with zero CLI installed.
 *            Agentic only where the model supports function-calling.
 *   tier 3 — FREE fallback (`kind: "api"`, `free: true`): a no-setup model so
 *            download→first-click does something; badged + capped.
 *
 * Capabilities are declared per provider so the UI can hide controls a provider
 * can't honor (e.g. reasoning `effort` or the tool-approval flow) instead of
 * faking them. The rust backend reads the same provider id to pick its path.
 *
 * This file is pure data + helpers — no React, no tauri. Safe to import anywhere
 * (and intentionally collision-free with the chat-pane UI work).
 */

import type { ChatModel } from "./chat";

export type ProviderKind = "cli" | "api";

/** Stable provider ids. The rust `ChatProvider` enum mirrors these. */
export type ProviderId =
	| "claude-cli"
	| "codex-cli"
	| "gemini-cli"
	| "opencode-cli"
	| "openai"
	| "openrouter"
	| "ollama"
	| "free";

/** What a provider can actually do — drives which composer pills/flows show. */
export interface ProviderCapabilities {
	/** Agentic tool-use with the interactive approval control protocol. */
	toolUse: boolean;
	/** Reasoning-effort selection (claude `--effort`; some API models). */
	effort: boolean;
	/** Native session resume (claude `--resume`); else we replay our transcript. */
	resume: boolean;
	/** Permission modes (bypass / plan / acceptEdits) — CLI-agent concept. */
	permissionModes: boolean;
}

/** No-capability baseline (plain streaming chat) — spread + override per provider. */
const PLAIN: ProviderCapabilities = {
	toolUse: false,
	effort: false,
	resume: false,
	permissionModes: false,
};

/** Full agentic baseline (a claude-grade coding-agent CLI). */
const FULL_AGENT: ProviderCapabilities = {
	toolUse: true,
	effort: true,
	resume: true,
	permissionModes: true,
};

export interface Provider {
	id: ProviderId;
	label: string;
	kind: ProviderKind;
	/** tier 1/2/3 — for grouping + the onboarding story. */
	tier: 1 | 2 | 3;
	capabilities: ProviderCapabilities;
	/** CLI providers: the binary name to detect on PATH / spawn. */
	bin?: string;
	/** API providers: env var(s) that supply the key (first found wins). */
	keyEnv?: string[];
	/** API providers: default base URL (overridable in settings, e.g. ollama). */
	defaultEndpoint?: string;
	/** Models offered by this provider for the picker. */
	models: ChatModel[];
	/** Free/no-setup tier — badge it in the UI. */
	free?: boolean;
	/** One-liner shown in the provider picker / onboarding. */
	note?: string;
}

// ── registry ─────────────────────────────────────────────────────────────────
// Order = display order (tier 1 agentic CLIs first, then APIs, then free).

export const PROVIDERS: Provider[] = [
	{
		id: "claude-cli",
		label: "Claude Code",
		kind: "cli",
		tier: 1,
		capabilities: FULL_AGENT,
		bin: "claude",
		models: [
			{ id: "claude-opus-4-8", label: "opus 4.8" },
			{ id: "claude-sonnet-4-6", label: "sonnet 4.6" },
			{ id: "claude-haiku-4-5", label: "haiku 4.5" },
		],
		note: "your Claude sub — full agent power",
	},
	{
		id: "codex-cli",
		label: "Codex",
		kind: "cli",
		tier: 1,
		// codex is agentic but has no claude-style effort/permission flags.
		capabilities: { ...FULL_AGENT, effort: false, permissionModes: false },
		bin: "codex",
		models: [{ id: "gpt-5-codex", label: "codex" }],
		note: "OpenAI's coding agent CLI",
	},
	{
		id: "gemini-cli",
		label: "Gemini CLI",
		kind: "cli",
		tier: 1,
		capabilities: { ...FULL_AGENT, effort: false, permissionModes: false },
		bin: "gemini",
		models: [{ id: "gemini-2.5-pro", label: "gemini 2.5 pro" }],
		note: "Google's agent CLI",
	},
	{
		id: "opencode-cli",
		label: "opencode",
		kind: "cli",
		tier: 1,
		capabilities: { ...FULL_AGENT, effort: false, permissionModes: false },
		bin: "opencode",
		models: [], // opencode is itself provider-agnostic; models come from its config
		note: "any model, agentic — provider-agnostic CLI",
	},
	{
		id: "openai",
		label: "OpenAI",
		kind: "api",
		tier: 2,
		capabilities: { ...PLAIN, toolUse: true },
		keyEnv: ["OPENAI_API_KEY"],
		defaultEndpoint: "https://api.openai.com/v1",
		models: [
			{ id: "gpt-5", label: "gpt-5" },
			{ id: "gpt-4o", label: "gpt-4o" },
			{ id: "o3", label: "o3" },
		],
		note: "BYO key — works with no CLI installed",
	},
	{
		id: "openrouter",
		label: "OpenRouter",
		kind: "api",
		tier: 2,
		capabilities: { ...PLAIN, toolUse: true },
		keyEnv: ["OPENROUTER_API_KEY"],
		defaultEndpoint: "https://openrouter.ai/api/v1",
		models: [
			{ id: "anthropic/claude-opus-4.1", label: "claude via OR" },
			{ id: "openai/gpt-5", label: "gpt-5 via OR" },
			{ id: "google/gemini-2.5-pro", label: "gemini via OR" },
		],
		note: "BYO key — one key, every model",
	},
	{
		id: "ollama",
		label: "Ollama (local)",
		kind: "api",
		tier: 2,
		capabilities: { ...PLAIN, toolUse: true },
		defaultEndpoint: "http://localhost:11434",
		models: [
			{ id: "llama3.3", label: "llama 3.3" },
			{ id: "qwen2.5-coder", label: "qwen2.5-coder" },
		],
		note: "fully local — no key, your machine",
	},
	{
		id: "free",
		label: "Free model",
		kind: "api",
		tier: 3,
		capabilities: PLAIN,
		defaultEndpoint: "https://openrouter.ai/api/v1",
		models: [{ id: "free-default", label: "free" }],
		free: true,
		note: "no setup — connect your account for full power",
	},
];

export const PROVIDER_BY_ID: Record<string, Provider> = Object.fromEntries(
	PROVIDERS.map((p) => [p.id, p]),
);

/** Default provider id — claude-cli keeps today's behavior for existing users. */
export const DEFAULT_PROVIDER_ID: ProviderId = "claude-cli";

export function getProvider(id: string | null | undefined): Provider {
	return (id && PROVIDER_BY_ID[id]) || PROVIDER_BY_ID[DEFAULT_PROVIDER_ID];
}

/** Models for a provider (falls back to empty so the picker degrades cleanly). */
export function modelsFor(id: string | null | undefined): ChatModel[] {
	return getProvider(id).models;
}

/**
 * Runtime availability of each provider, filled by the rust `detect_providers`
 * command (CLI on PATH? API key present?). Used by onboarding + the picker to
 * gray out / badge providers the user can't run yet.
 */
export interface ProviderStatus {
	id: ProviderId;
	available: boolean;
	/** for CLI: resolved binary path; for API: which key env was found. */
	detail?: string;
}
