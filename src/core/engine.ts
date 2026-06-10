import type { Config } from "./config.js";
import type {
  Entity,
  PipelineOptions,
  PipelineResult,
  DetectionResult,
} from "./types.js";
import { normalize, type NormalizeRequest } from "./normalize.js";
import { detect } from "./detect.js";
import { classifyPage } from "./classify.js";
import { llmClassifyPage } from "./classify-llm.js";
import { deterministicExtract } from "./extract/deterministic.js";
import { llmExtract } from "./extract/llm.js";
import { reconcile } from "./reconcile.js";
import { validate } from "./validate.js";
import { toJsonLd } from "./serialize.js";
import { SchemaBrain } from "./schema-brain.js";
import { JsonRegistry, type Registry } from "./registry.js";
import { makeProvider, type LlmProvider } from "./llm/provider.js";

/**
 * Long-lived engine: loads the schema brain + registry once and reuses them
 * across requests (important for the web server and for cross-page memory).
 */
export class Engine {
  private constructor(
    private cfg: Config,
    private brain: SchemaBrain,
    private registry: Registry,
    private llm: LlmProvider,
  ) {}

  static async create(cfg: Config): Promise<Engine> {
    const brain = await SchemaBrain.load(cfg.schemaDumpPath);
    const registry = await JsonRegistry.open(cfg.registryPath);
    const llm = makeProvider(cfg);
    return new Engine(cfg, brain, registry, llm);
  }

  async run(
    req: NormalizeRequest,
    opts: PipelineOptions = {},
  ): Promise<PipelineResult> {
    const mode = opts.mode || "auto";

    // 1) Normalize
    const normalized = await normalize(
      {
        ...req,
        extraText: opts.extraText ?? req.extraText,
        langOverride: opts.requestContext?.lang,
      },
      this.cfg,
    );

    // 2) Detect existing markup + plugins
    const detection: DetectionResult = detect(normalized.html);

    // Use caller-supplied LLM override first; fall back to server's configured provider.
    const llm = opts.llmOverride ?? this.llm;
    const llmAvailable = mode === "auto" && (opts.llmOverride != null || this.cfg.llmProvider !== "none");

    // 3) Classify page type.
    // In auto mode with LLM available: use the LLM type-selector pre-call which
    // sees all 932 schema.org types and picks the best fit (Approach B).
    // The type list lives in the system prompt so providers cache it across requests.
    // In deterministic mode: fall back to the fast heuristic classifier.
    let classification = classifyPage(normalized);
    if (llmAvailable) {
      try {
        classification = await llmClassifyPage(normalized, this.brain, llm);
      } catch (err) {
        console.warn("[engine] LLM classify failed, using heuristic:", err);
      }
    }

    // 4) Deterministic extraction (uses classification hints)
    let entities: Entity[] = deterministicExtract(normalized, detection, classification);

    // 5) LLM depth extraction (unless deterministic-only)
    if (llmAvailable) {
      try {
        const deep = await llmExtract(normalized, entities, this.brain, llm, classification, opts.requestContext);
        entities = [...entities, ...deep];
      } catch (err) {
        // Never fail the whole run because the LLM hiccuped.
        console.error("[engine] LLM extraction failed:", err);
      }
    }

    // 6) Manual entities seed/override
    if (opts.manualEntities?.length) {
      entities = [...entities, ...opts.manualEntities];
    }

    // 7) Reconcile (ids + memory) and 8) validate
    const graph = await reconcile(normalized, entities, this.registry);
    await this.registry.flush();
    const validation = validate(graph, this.brain);
    const jsonld = toJsonLd(graph);

    return {
      normalized,
      detection,
      graph,
      jsonld,
      validation,
      recommendation: recommend(detection),
    };
  }
}

function recommend(detection: DetectionResult): PipelineResult["recommendation"] {
  if (!detection.hasExistingMarkup) return "add";
  // If a known SEO plugin owns the graph, merging blindly causes duplicates.
  // Recommend replace (disable plugin output) or careful merge.
  if (detection.detectedPlugins.some((p) => p === "yoast" || p === "rankmath")) {
    return "replace";
  }
  return "merge";
}
