import "dotenv/config";

export interface Config {
  llmProvider: "anthropic" | "openai" | "none";
  anthropicApiKey?: string;
  anthropicModel: string;
  openaiApiKey?: string;
  openaiModel: string;
  port: number;
  fetchUserAgent: string;
  fetchMaxBytes: number;
  registryPath: string;
  schemaDumpPath: string;
  authUser: string;
  authPassword: string;
}

export function loadConfig(): Config {
  return {
    llmProvider: (process.env.LLM_PROVIDER as Config["llmProvider"]) || "none",
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    anthropicModel: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514",
    openaiApiKey: process.env.OPENAI_API_KEY,
    openaiModel: process.env.OPENAI_MODEL || "gpt-4o",
    port: Number(process.env.PORT || 8420),
    fetchUserAgent:
      process.env.FETCH_USER_AGENT || "SchemaForgeBot/0.1 (+https://example.com)",
    fetchMaxBytes: Number(process.env.FETCH_MAX_BYTES || 3_000_000),
    registryPath: process.env.REGISTRY_PATH || "./data/registry.json",
    schemaDumpPath:
      process.env.SCHEMA_DUMP_PATH || "./data/schemaorg-current-https.jsonld",
    authUser: process.env.AUTH_USER || "stephan",
    authPassword: process.env.AUTH_PASSWORD || "TestSchemaForge",
  };
}
