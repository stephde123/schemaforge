// Shared domain types for the whole pipeline.
// Each pipeline stage takes a typed input and returns a typed output so stages
// stay swappable and testable in isolation.

export type EntitySource = "deterministic" | "llm" | "existing" | "manual";

/**
 * Structured data collected directly from the WordPress CMS before the request
 * is sent to the API server. These values are authoritative — the LLM should
 * prefer them over anything inferred from scraped HTML.
 */
export interface WpSignals {
  post?: {
    type?: string;           // WP post_type: "post", "page", "product", "tribe_events", …
    title?: string;
    excerpt?: string;
    author?: { name?: string; bio?: string; url?: string };
    featuredImage?: { url?: string; alt?: string };
    publishedAt?: string;    // ISO 8601
    modifiedAt?: string;
  };
  taxonomy?: {
    categories?: string[];
    tags?: string[];
    custom?: Record<string, string[]>;   // e.g. { "product_cat": ["Shirts", "Sale"] }
  };
  site?: {
    name?: string;
    description?: string;
    url?: string;
    logo?: string;
  };
  /** Non-private post meta keys (no leading underscore). Values truncated to 300 chars. */
  meta?: Record<string, unknown>;
  woocommerce?: {
    sku?: string;
    price?: string;
    regularPrice?: string;
    salePrice?: string;
    currency?: string;
    availability?: string;   // "InStock" | "OutOfStock"
    weight?: string;
    dimensions?: { length?: string; width?: string; height?: string };
    categories?: string[];
  };
}

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
  /**
   * Cleaned HTML for LLM consumption: noise elements removed, non-semantic
   * attributes stripped, but all structural/semantic tags preserved.
   * Prefer this over `text` when sending to an LLM — the tag structure
   * (headings, lists, tables, details/summary, …) adds extraction signal.
   */
  cleanedHtml?: string;
  /** Plain text extracted from HTML, plus any user-supplied extra text. */
  text: string;
  /** Detected primary language (BCP-47), e.g. "de". */
  lang?: string;
  /** Page title if available. */
  title?: string;
  /** Raw extra text supplied by the user — kept separate so LLM can treat it as binding instructions. */
  userInstructions?: string;
  /** Authoritative CMS data supplied by the WordPress companion plugin. */
  wpSignals?: WpSignals;
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
  /** Whether the LLM was actually invoked and succeeded, or only deterministic rules ran. */
  usedMode: "llm" | "deterministic";
  /** 0–1: how confident the classifier is about the detected primary page type. */
  classificationConfidence: number;
}

/** Caller-supplied context hints (e.g. from the WordPress companion plugin). */
export interface RequestContext {
  /** Which SEO plugin is active on the site (e.g. "yoast", "rankmath"). */
  detectedPlugin?: string;
  /** The caller's configured merge strategy. Informational; does not override recommendation. */
  strategy?: "auto" | "merge" | "replace" | "add";
  /** BCP-47 language hint (e.g. "de"). Overrides HTML lang detection in normalize. */
  lang?: string;
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
  /** Optional context hints from the caller (e.g. WordPress companion plugin). */
  requestContext?: RequestContext;
}
