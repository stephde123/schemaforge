// Shared domain types for the whole pipeline.
// Each pipeline stage takes a typed input and returns a typed output so stages
// stay swappable and testable in isolation.

export type EntitySource = "deterministic" | "llm" | "existing" | "manual";

/**
 * An internal representation of a schema.org node before it is serialized to
 * JSON-LD. We keep `type` and `props` separate from the final `@id` so that
 * reconciliation can assign/merge ids late.
 */
export interface Entity {
  /** Final @id (an IRI). Assigned during reconcile, may be undefined earlier. */
  id?: string;
  /** schema.org type(s), e.g. "Place" or ["LocalBusiness","SportsActivityLocation"]. */
  type: string | string[];
  /** All other schema.org properties. Values may reference other entities via { "@id": ... }. */
  props: Record<string, unknown>;
  /**
   * Internal reconciliation key (normalized name + type, or a sameAs URI).
   * Never serialized. Used to dedupe within a run and against the registry.
   */
  _key?: string;
  _source: EntitySource;
}

export interface EntityGraph {
  entities: Entity[];
}

/** Output of the normalize stage. */
export interface NormalizedInput {
  /** Canonical URL of the page if known (used for id minting). */
  canonicalUrl?: string;
  /** The URL the content actually came from, if fetched. */
  sourceUrl?: string;
  /** Raw HTML, if any. */
  html?: string;
  /** Plain text extracted from HTML, plus any user-supplied extra text. */
  text: string;
  /** Detected primary language (BCP-47), e.g. "de". */
  lang?: string;
  /** Page title if available. */
  title?: string;
}

export type SchemaPlugin =
  | "yoast"
  | "rankmath"
  | "schema-pro"
  | "the-seo-framework"
  | "aioseo"
  | "wordpress-generic"
  | "unknown";

export interface ExistingMarkupItem {
  format: "json-ld" | "microdata" | "rdfa";
  /** Parsed object(s) found. For JSON-LD this is the parsed JSON. */
  data: unknown;
  /** Best guess of which tool emitted it. */
  plugin: SchemaPlugin;
}

/** Output of the detect stage. */
export interface DetectionResult {
  existing: ExistingMarkupItem[];
  /** Plugins/themes fingerprinted on the page. */
  detectedPlugins: SchemaPlugin[];
  /** True if the page already ships any structured data. */
  hasExistingMarkup: boolean;
}

export interface ValidationIssue {
  level: "error" | "warning" | "info";
  /** @id or type the issue relates to. */
  subject?: string;
  message: string;
}

export interface ValidationReport {
  issues: ValidationIssue[];
  /** 0..1 — rough coverage of recommended properties for the detected types. */
  coverageScore: number;
  /** Per Google rich-results: which required props are missing, by type. */
  missingRequired: Record<string, string[]>;
}

/** The full result returned to the CLI / web UI. */
export interface PipelineResult {
  normalized: NormalizedInput;
  detection: DetectionResult;
  graph: EntityGraph;
  /** Final JSON-LD ready to paste into the page. */
  jsonld: Record<string, unknown>;
  validation: ValidationReport;
  /** What we recommend the user do with existing markup. */
  recommendation: "add" | "merge" | "replace" | "none";
}

export interface PipelineOptions {
  /** "auto" runs LLM deep extraction; "deterministic" skips it. */
  mode?: "auto" | "deterministic";
  /** When set, this provider is used instead of the server's configured LLM. */
  llmOverride?: import("./llm/provider.js").LlmProvider;
  /** Extra free-text the user pasted to enrich extraction. */
  extraText?: string;
  /** Manually supplied entities to seed/override the graph. */
  manualEntities?: Entity[];
}
