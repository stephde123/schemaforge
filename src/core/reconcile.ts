import { createHash } from "node:crypto";
import type { Entity, EntityGraph, NormalizedInput } from "./types.js";
import type { Registry } from "./registry.js";

/**
 * Turn a loose list of entities (from existing markup + deterministic + LLM)
 * into a clean graph: dedupe within the run, assign stable @ids.
 *
 * The registry is used ONLY for @id stability — if the same entity key was
 * seen before, it keeps the same @id across runs. No properties are read from
 * or written to the registry; the current run is always authoritative for props.
 */
export async function reconcile(
  input: NormalizedInput,
  entities: Entity[],
  registry: Registry,
): Promise<EntityGraph> {
  const pageUrl = input.canonicalUrl || input.sourceUrl || "";
  const base = (pageUrl || "urn:schemaforge")
    .replace(/#.*$/, "")
    .replace(/\/$/, "");

  // 1) Compute a reconciliation key for each entity (may be null — see keyFor).
  for (const e of entities) {
    if (!e._key) {
      const k = keyFor(e, pageUrl);
      if (k) e._key = k;
    }
  }

  // 2) Merge entities that share a key within this run. Unkeyed entities are
  //    always distinct — they get a content-hash id and never touch the store.
  const byKey = new Map<string, Entity>();
  const unkeyed: Entity[] = [];
  for (const e of entities) {
    if (!e._key) {
      unkeyed.push({ ...e });
      continue;
    }
    const existing = byKey.get(e._key);
    if (existing) {
      existing.props = mergeProps(existing.props, e.props);
      existing.type = combineTypes(existing.type, e.type);
      if (!existing.id && e.id) existing.id = e.id;
    } else {
      byKey.set(e._key, { ...e });
    }
  }

  // 3) Resolve @id from registry (stability only) then mint if new.
  const result: Entity[] = [];
  for (const e of [...byKey.values(), ...unkeyed]) {
    if (!e.id && e._key) {
      const reg = registry.resolve(e._key);
      // Only trust a stored id whose type is in the same family — guards against
      // a stale key collision handing an Organization a Person's id, etc.
      if (reg && sameFamily(reg.type, e.type)) e.id = reg.id;
    }
    if (!e.id) e.id = mintId(base, e);

    // The bare page URL is the WebPage node's @id. Anything else that ends up
    // holding it collides with the page node and gets dropped in finalize.
    const primaryType = Array.isArray(e.type) ? e.type[0]! : e.type;
    if (
      !PAGE_TYPES.has(primaryType) &&
      !e.id.includes("#") &&
      e.id.replace(/\/$/, "") === base
    ) {
      e.id = mintId(base, e);
    }

    if (e._key) {
      registry.upsert({
        key: e._key,
        id: e.id,
        type: e.type,
        name:
          firstString(e.props["name"]) ??
          firstString(e.props["headline"]) ??
          undefined,
      });
    }

    result.push(e);
  }

  return { entities: result };
}

// ---------------------------------------------------------------------------
// Type families
// ---------------------------------------------------------------------------

const ARTICLE_TYPES = new Set([
  "Article", "BlogPosting", "NewsArticle", "TechArticle", "Report",
  "ScholarlyArticle", "SocialMediaPosting", "LiveBlogPosting",
  "AdvertiserContentArticle", "SatiricalArticle", "AnalysisNewsArticle",
  "AskPublicNewsArticle", "BackgroundNewsArticle", "OpinionNewsArticle",
  "ReportageNewsArticle", "ReviewNewsArticle",
]);

const PAGE_TYPES = new Set([
  "WebPage", "AboutPage", "ContactPage", "FAQPage", "QAPage", "ProfilePage",
  "CollectionPage", "ItemPage", "SearchResultsPage", "CheckoutPage",
  "MedicalWebPage",
]);

const MEDIA_TYPES = new Set([
  "ImageObject", "VideoObject", "AudioObject", "MediaObject",
]);

/** Collapse refinements to one label so TechArticle and Article share a key. */
function familyLabel(type: string): string {
  if (ARTICLE_TYPES.has(type)) return "Article";
  if (PAGE_TYPES.has(type)) return "WebPage";
  return type;
}

// ---------------------------------------------------------------------------
// Keying
// ---------------------------------------------------------------------------

/**
 * Canonical reconciliation key, or null when the entity has no stable
 * identifier (then it gets a per-run content-hash id and is never persisted).
 *
 * Priority:
 *   - page-bound singletons (Article/WebPage families, HowTo) → one per
 *     (owning page, family), keyed on the page URL
 *   - media objects → the file URL
 *   - a fragment @id the page already assigned
 *   - a `url` that identifies the thing
 *   - a human label (name / legalName / headline), scoped to the site host
 *
 * Cross-site safety: every label-based key carries the host, so two sites with
 * an "Organization: Home" can't share one @id.
 */
function keyFor(e: Entity, pageUrl: string): string | null {
  const types = Array.isArray(e.type) ? e.type : [e.type];
  const primary = types[0] || "Thing";

  const pageBound = types.some(
    (t) => ARTICLE_TYPES.has(t) || PAGE_TYPES.has(t) || t === "HowTo",
  );
  if (pageBound) {
    const owner =
      firstString(e.props["url"]) ??
      refUrl(e.props["mainEntityOfPage"]) ??
      refUrl(e.props["isPartOf"]) ??
      (PAGE_TYPES.has(primary) || ARTICLE_TYPES.has(primary) || primary === "HowTo"
        ? pageUrl
        : null);
    if (owner) return `${familyLabel(primary)}@${canonUrl(owner)}`;
  }

  if (MEDIA_TYPES.has(primary)) {
    const src = firstString(e.props["contentUrl"]) ?? firstString(e.props["url"]);
    return src ? `${primary}@${canonUrl(src)}` : null;
  }

  const ownId = typeof e.id === "string" && e.id ? e.id : null;
  if (ownId && (PAGE_TYPES.has(primary) || ownId.includes("#"))) {
    return `${primary}@id:${ownId.replace(/\/$/, "")}`;
  }

  const url = firstString(e.props["url"]);
  if (url) return `${primary}@${canonUrl(url)}`;

  const label =
    firstString(e.props["name"]) ??
    firstString(e.props["legalName"]) ??
    firstString(e.props["headline"]);
  if (label) {
    const host =
      hostOf(pageUrl) ??
      hostOf(refUrl(e.props["mainEntityOfPage"])) ??
      hostOf(ownId);
    return host
      ? `${primary}@${host}:${normalize(label)}`
      : `${primary}:${normalize(label)}`;
  }

  return null;
}

/** Mint a stable, content-derived fragment id under the page base. */
function mintId(base: string, e: Entity): string {
  const primaryType = (Array.isArray(e.type) ? e.type[0] : e.type) || "thing";
  const seed = e._key ?? stableStringify(e.props);
  const h = createHash("sha1").update(seed).digest("hex").slice(0, 8);
  return `${base}/#${primaryType.toLowerCase()}-${h}`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mergeProps(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (out[k] == null || out[k] === "") out[k] = v;
  }
  return out;
}

/**
 * Union two type lists for entities that reconciled to the same key. Keeps
 * cross-family combinations that are meaningful (WebPage + FAQPage) but drops
 * bare "Article" when a specific article subtype is also present.
 */
function combineTypes(
  a: string | string[],
  b: string | string[],
): string | string[] {
  const all = [...new Set([...toArr(a), ...toArr(b)])];
  const hasSpecificArticle = all.some((t) => ARTICLE_TYPES.has(t) && t !== "Article");
  const out = hasSpecificArticle ? all.filter((t) => t !== "Article") : all;
  return out.length === 1 ? out[0]! : out;
}

function sameFamily(a: string | string[], b: string | string[]): boolean {
  const fa = new Set(toArr(a).map(familyLabel));
  return toArr(b).map(familyLabel).some((f) => fa.has(f));
}

function toArr<T>(v: T | T[]): T[] {
  return Array.isArray(v) ? v : [v];
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Host + path, www-stripped and trailing-slash-stripped, then normalized. */
function canonUrl(u: string): string {
  try {
    const url = new URL(u);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const path = url.pathname.replace(/\/+$/, "");
    return normalize(host + path);
  } catch {
    return normalize(u);
  }
}

function hostOf(u: string | null | undefined): string | null {
  if (!u) return null;
  try {
    return new URL(u).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

function refUrl(v: unknown): string | null {
  if (typeof v === "string") return v || null;
  if (Array.isArray(v)) {
    for (const x of v) {
      const r = refUrl(x);
      if (r) return r;
    }
    return null;
  }
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const id = o["@id"] ?? o["url"];
    return typeof id === "string" ? id : null;
  }
  return null;
}

function firstString(v: unknown): string | null {
  if (typeof v === "string") return v.trim() || null;
  if (Array.isArray(v)) {
    for (const x of v) {
      const s = firstString(x);
      if (s) return s;
    }
  }
  return null;
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(",")}}`;
}
