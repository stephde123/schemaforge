import type { NormalizedInput } from "./types.js";
import type { SchemaBrain } from "./schema-brain.js";
import type { LlmProvider } from "./llm/provider.js";
import type { PageClassification } from "./classify.js";
import { classifyPage } from "./classify.js";

/**
 * LLM-based page type selector (Approach B).
 *
 * Sends the full list of schema.org types (from the brain) plus a short page
 * excerpt to the LLM and asks it to pick the 2–8 most relevant types.
 * This replaces the hand-written heuristic classify.ts in auto mode.
 *
 * The type list goes in the SYSTEM prompt so providers can cache it across
 * requests — the user prompt stays small (URL + title + text excerpt only).
 */
export async function llmClassifyPage(
  input: NormalizedInput,
  brain: SchemaBrain,
  llm: LlmProvider,
): Promise<PageClassification> {
  if (!brain.loaded) return classifyPage(input);

  // Build (and cache in module scope) the system prompt that embeds all type names.
  const system = buildSystemPrompt(brain);

  const user = JSON.stringify({
    url: input.canonicalUrl || input.sourceUrl || "",
    title: input.title || "",
    // Enough text to catch secondary facets (a docs page that also reviews a
    // product, an about page that also lists events) — not the whole page.
    excerpt: input.text.slice(0, 8000),
  });

  let raw: string;
  try {
    raw = await llm.complete(system, user);
  } catch (err) {
    console.warn("[classify-llm] type-selector call failed, falling back to heuristic:", err);
    return classifyPage(input);
  }

  const { types, confidence } = parseClassifyResponse(raw);
  if (!types.length) return classifyPage(input);

  // Filter to types that actually exist in the schema.org brain
  let valid = types.filter((t) => brain.hasType(t));
  if (!valid.length) return classifyPage(input);

  // The LLM keys on what a page is ABOUT; a /docs/, /blog/, /guide/ URL is a
  // near-certain signal that the page IS an article regardless. When the
  // heuristic caught such a URL rule and the LLM led with an entity type
  // instead, put the content type first and keep the LLM's pick as secondary
  // (it becomes `about` / `mainEntity` downstream).
  const heuristic = classifyPage(input);
  valid = reconcileContentType(heuristic, valid);

  return {
    primaryHint: valid[0]!,
    additionalHints: valid.slice(1),
    signals: ["llm-type-selector", ...valid.map((t) => `llm:${t}`)],
    confidence,
  };
}

const CONTENT_TYPES = new Set([
  "Article", "TechArticle", "BlogPosting", "NewsArticle", "Report",
  "ScholarlyArticle", "HowTo", "FAQPage", "QAPage",
]);

function reconcileContentType(
  heuristic: PageClassification,
  llmTypes: string[],
): string[] {
  const hp = heuristic.primaryHint;
  const fromUrlRule = heuristic.signals.some((s) => s.startsWith("url:"));
  if (
    CONTENT_TYPES.has(hp) &&
    fromUrlRule &&
    !CONTENT_TYPES.has(llmTypes[0] ?? "")
  ) {
    return [hp, ...llmTypes.filter((t) => t !== hp)];
  }
  return llmTypes;
}

// ---------------------------------------------------------------------------
// System prompt — built once, reused across calls (providers cache identical
// system prompts, so the large type list is only billed on first use per session)
// ---------------------------------------------------------------------------

let _cachedSystem: string | null = null;
let _cachedBrainKey: string | null = null;

// Bump this when the prompt format changes to bust the module-level cache.
const CLASSIFIER_VERSION = "v4";

function buildSystemPrompt(brain: SchemaBrain): string {
  const key = CLASSIFIER_VERSION + ":" + String(brain.allTypes().length);
  if (_cachedSystem && _cachedBrainKey === key) return _cachedSystem;

  // Only include uppercase-starting types — lowercase entries are data types
  // (Boolean, Text, etc.) that are never the primary type of a page.
  const allTypes = brain
    .allTypes()
    .filter((t) => /^[A-Z]/.test(t))
    .sort()
    .join(", ");

  _cachedSystem = `You are a schema.org type classifier.
Given a web page URL, title, and a text excerpt, identify the 3 to 12 schema.org types that best describe the page. Lead with the type of the page's PRIMARY content, then every secondary type that would carry genuine structured-data value (things the page is about, sub-structures like FAQ/HowTo, the site's organization, media). More specific and more parallel types are better as long as they are actually supported by the page.

Rules:
- IS vs ABOUT: if the page is an article, blog post, news story, tutorial, guide, FAQ, or product/software documentation, the PRIMARY type is the content type (TechArticle for docs/API/dev content, HowTo for step-by-step guides, NewsArticle, BlogPosting, FAQPage, else Article). A product, software, organization, or person the text merely describes is a SECONDARY type in the list (it becomes the article's subject), never the primary. URL cues: /docs/, /kb/, /help/, /guide/, /tutorial/, /how-to/, /blog/, /news/, /article/, dated paths → content page. /pricing/, /features/, /download/, /product/ → the entity's own page.
- Always pick the MOST SPECIFIC subtype available (CatholicChurch > Church > PlaceOfWorship > LocalBusiness).
- Include parallel types that add genuine structured-data value (historic church → ["CatholicChurch", "TouristAttraction", "LandmarksOrHistoricalBuildings"]; a docs page about an API → ["TechArticle", "WebAPI"]).
- Omit abstract parents already implied by a specific child in your list (no "LocalBusiness" if "Restaurant" is already there).
- Omit pure page-infrastructure types: WebPage, WebSite, BreadcrumbList, SiteNavigationElement. (Article/TechArticle/HowTo/FAQPage are CONTENT, not infrastructure — include them.)
- Output ONLY a valid JSON object with exactly two fields:
  {"types": ["Type1", "Type2", ...], "confidence": 0.0}
  where "confidence" is a float 0.0–1.0 reflecting how unambiguously the page type is identifiable
  (1.0 = crystal-clear, 0.5 = genuinely ambiguous, 0.2 = almost no signal).
  No explanation, no code fences, no prose — just the JSON object.

Available schema.org types:
${allTypes}`;

  _cachedBrainKey = key;
  return _cachedSystem;
}

// ---------------------------------------------------------------------------
// Parse the LLM response — handles new {"types":[…],"confidence":0.9} format
// and falls back to a plain array for backward compatibility.
// ---------------------------------------------------------------------------

function parseClassifyResponse(raw: string): { types: string[]; confidence: number } {
  const cleaned = raw.replace(/```(?:json)?/gi, "").trim();
  const toStrings = (arr: unknown) =>
    Array.isArray(arr) ? arr.filter((t): t is string => typeof t === "string") : [];
  const clampConf = (n: unknown) =>
    typeof n === "number" ? Math.min(1, Math.max(0, n)) : 0.85;

  try {
    const parsed = JSON.parse(cleaned);
    // New format: { types: [...], confidence: 0.9 }
    if (parsed && !Array.isArray(parsed) && Array.isArray(parsed.types)) {
      return { types: toStrings(parsed.types), confidence: clampConf(parsed.confidence) };
    }
    // Backward compat: plain array
    if (Array.isArray(parsed)) {
      return { types: toStrings(parsed), confidence: 0.85 };
    }
  } catch {}

  // Fall back: extract first {...} or [...] block
  const objMatch = cleaned.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try {
      const parsed = JSON.parse(objMatch[0]);
      if (parsed && Array.isArray(parsed.types)) {
        return { types: toStrings(parsed.types), confidence: clampConf(parsed.confidence) };
      }
    } catch {}
  }
  const arrMatch = cleaned.match(/\[[\s\S]*?\]/);
  if (arrMatch) {
    try {
      const parsed = JSON.parse(arrMatch[0]);
      if (Array.isArray(parsed)) return { types: toStrings(parsed), confidence: 0.85 };
    } catch {}
  }
  return { types: [], confidence: 0 };
}
