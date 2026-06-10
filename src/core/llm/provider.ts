import type { Config } from "../config.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAIProvider } from "./openai.js";

export interface LlmProvider {
  /** Send a system + user prompt, return raw text (expected JSON). */
  complete(system: string, user: string): Promise<string>;
}

/** No-op provider for deterministic-only mode. */
class NullProvider implements LlmProvider {
  async complete(): Promise<string> {
    return "[]";
  }
}

export function makeProvider(cfg: Config): LlmProvider {
  switch (cfg.llmProvider) {
    case "anthropic":
      if (!cfg.anthropicApiKey) throw new Error("ANTHROPIC_API_KEY missing");
      return new AnthropicProvider(cfg.anthropicApiKey, cfg.anthropicModel);
    case "openai":
      if (!cfg.openaiApiKey) throw new Error("OPENAI_API_KEY missing");
      return new OpenAIProvider(cfg.openaiApiKey, cfg.openaiModel);
    default:
      return new NullProvider();
  }
}

/** Build a one-shot provider from a user-supplied API key (no server config needed). */
export function makeProviderFromKey(
  provider: "openai" | "anthropic",
  apiKey: string,
): LlmProvider {
  switch (provider) {
    case "anthropic":
      return new AnthropicProvider(apiKey, "claude-sonnet-4-6");
    case "openai":
      return new OpenAIProvider(apiKey, "gpt-4o");
  }
}
