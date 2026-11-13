import {
  CLAUDE_CLI_PROVIDER_ID,
  CODEX_CLI_PROVIDER_ID,
  GEMINI_CLI_PROVIDER_ID,
  LOCAL_CLI_PLACEHOLDER_SECRET,
  OPENCODE_CLI_PROVIDER_ID,
} from "./pi-cli-provider.js";

export const DEFAULT_OPENROUTER_MODEL_ID = "openai/gpt-5.6-luna";

/**
 * The deployment-wide model default: which provider a run falls back to when no user
 * credential applies, and the key for that provider.
 *
 * Vendor env names and model ids live here, in the adapter layer, not in core.
 */
export function resolveDeploymentModel(env: NodeJS.ProcessEnv = process.env) {
  const provider = env.PI_DEFAULT_PROVIDER?.trim() || "openrouter";
  // A row per provider that ships a deployment key. A third one adds a row here, not a
  // branch at each call site — and an unknown provider gets no key rather than another
  // vendor's, which a ternary on one provider would not give.
  const keys: Record<string, string | undefined> = {
    openrouter: env.OPENROUTER_API_KEY,
    anthropic: env.ANTHROPIC_API_KEY,
    [CLAUDE_CLI_PROVIDER_ID]: LOCAL_CLI_PLACEHOLDER_SECRET,
    [CODEX_CLI_PROVIDER_ID]: LOCAL_CLI_PLACEHOLDER_SECRET,
    [GEMINI_CLI_PROVIDER_ID]: LOCAL_CLI_PLACEHOLDER_SECRET,
    [OPENCODE_CLI_PROVIDER_ID]: LOCAL_CLI_PLACEHOLDER_SECRET,
  };
  const models: Record<string, string> = {
    openrouter: DEFAULT_OPENROUTER_MODEL_ID,
    anthropic: "claude-sonnet-5",
    [CLAUDE_CLI_PROVIDER_ID]: "sonnet",
    [CODEX_CLI_PROVIDER_ID]: "gpt-5.4",
    [GEMINI_CLI_PROVIDER_ID]: "gemini-2.5-pro",
    [OPENCODE_CLI_PROVIDER_ID]: "default",
  };
  return {
    provider,
    model: env.PI_DEFAULT_MODEL?.trim() || models[provider] || models.openrouter!,
    key: keys[provider],
  };
}
