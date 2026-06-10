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
    // Short excerpt — type selection doesn't need the full page text
    excerpt: input.text.slice(0, 3000),
  });

  let raw: string;
  try {
    raw = await llm.complete(system, user);
  } catch (err) {
    console.warn("[classify-llm] type-selector call failed, falling back to heuristic:", err);
    return classifyPage(input);
  }

  const types = parseTypeArray(raw);
  if (!types.length) return classifyPage(input);

  // Filter to types that actually exist in the schema.org brain
  const valid = types.filter((t) => brain.hasType(t));
  if (!valid.length) return classifyPage(input);

  return {
    primaryHint: valid[0]!,
    additionalHints: valid.slice(1),
    signals: ["llm-type-selector", ...valid.map((t) => `llm:${t}`)],
  };
}

// ---------------------------------------------------------------------------
// System prompt — built once, reused across calls (providers cache identical
// system prompts, so the large type list is only billed on first use per session)
// ---------------------------------------------------------------------------

let _cachedSystem: string | null = null;
let _cachedBrainKey: string | null = null; // invalidate if brain is reloaded

function buildSystemPrompt(brain: SchemaBrain): string {
  // Use a simple cache key: number of types (changes only when schema dump is updated)
  const key = String(brain.allTypes().length);
  if (_cachedSystem && _cachedBrainKey === key) return _cachedSystem;

  // Only include uppercase-starting types — lowercase entries are data types
  // (Boolean, Text, etc.) that are never the primary type of a page.
  const allTypes = brain
    .allTypes()
    .filter((t) => /^[A-Z]/.test(t))
    .sort()
    .join(", ");

  _cachedSystem = `You are a schema.org type classifier.
Given a web page URL, title, and a short text excerpt, return a JSON array of 2–8 schema.org types that best describe the page's PRIMARY content.

Rules:
- Always pick the MOST SPECIFIC subtype available (CatholicChurch > Church > PlaceOfWorship > LocalBusiness).
- Include parallel types that add genuine structured-data value (historic church → ["CatholicChurch", "TouristAttraction", "LandmarksOrHistoricalBuildings"]).
- Omit abstract parents already implied by a specific child in your list (no "LocalBusiness" if "Restaurant" is already there).
- Omit page-infrastructure types: WebPage, WebSite, BreadcrumbList, SiteNavigationElement.
- Output ONLY a valid JSON array. No explanation, no code fences, no prose.

Available schema.org types:
${allTypes}`;

  _cachedBrainKey = key;
  return _cachedSystem;
}

// ---------------------------------------------------------------------------
// Parse the LLM response into a string array
// ---------------------------------------------------------------------------

function parseTypeArray(raw: string): string[] {
  const cleaned = raw.replace(/```(?:json)?/gi, "").trim();
  // Try direct JSON parse first
  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) return parsed.filter((t): t is string => typeof t === "string");
  } catch {}
  // Fall back to extracting the first [...] block
  const m = cleaned.match(/\[[\s\S]*?\]/);
  if (m) {
    try {
      const parsed = JSON.parse(m[0]);
      if (Array.isArray(parsed)) return parsed.filter((t): t is string => typeof t === "string");
    } catch {}
  }
  return [];
}
