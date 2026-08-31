import type { Entity, EntityGraph, ValidationIssue } from "./types.js";

/**
 * Graph-integrity pass. Runs after reconcile (ids assigned) and before validate
 * / serialize. Enforces invariants that no single extractor can guarantee on its
 * own, because the final graph is the concatenation of three independent sources
 * (existing markup + deterministic rules + LLM):
 *
 *   1. every @id is unique — nodes that collide are merged, not duplicated
 *   2. one page node and one article node per page — related subtypes
 *      (Article/TechArticle, WebPage/FAQPage) are refinements of the same
 *      real-world entity and must not appear as separate nodes
 *   3. every { "@id": … } reference resolves to a node in the graph — dangling
 *      references are rewired to the real node, inlined, or dropped
 *   4. purely subordinate nodes that nothing references are pruned
 *
 * Returns the cleaned graph plus a list of issues describing what was changed,
 * so the caller can surface them in the validation report.
 */
export function finalizeGraph(
  graph: EntityGraph,
  pageUrl?: string,
): { graph: EntityGraph; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  let entities = graph.entities.map(cloneEntity);

  entities = mergeById(entities, issues);
  entities = collapseFamily(entities, ARTICLE_TYPES, "article", pageUrl, issues);
  entities = collapseFamily(entities, PAGE_TYPES, "page", pageUrl, issues);
  entities = mergeById(entities, issues); // family collapse can re-collide ids
  fixReferences(entities, issues);
  entities = pruneOrphans(entities, issues);

  return { graph: { entities }, issues };
}

// ---------------------------------------------------------------------------
// Type families — members are refinements of one real-world node
// ---------------------------------------------------------------------------

const PAGE_TYPES = new Set([
  "WebPage", "AboutPage", "ContactPage", "FAQPage", "QAPage", "ProfilePage",
  "CollectionPage", "ItemPage", "SearchResultsPage", "CheckoutPage",
  "MedicalWebPage",
]);

const ARTICLE_TYPES = new Set([
  "Article", "BlogPosting", "NewsArticle", "TechArticle", "Report",
  "ScholarlyArticle", "SocialMediaPosting", "LiveBlogPosting",
  "AdvertiserContentArticle", "SatiricalArticle", "AnalysisNewsArticle",
  "AskPublicNewsArticle", "BackgroundNewsArticle", "OpinionNewsArticle",
  "ReportageNewsArticle", "ReviewNewsArticle",
]);

/** Types that only make sense hanging off another node. */
const SUBORDINATE_TYPES = new Set([
  "ImageObject", "Offer", "AggregateOffer", "AggregateRating", "Rating",
  "Review", "ContactPoint", "PostalAddress", "GeoCoordinates", "ListItem",
  "Answer", "Question", "QuantitativeValue", "OpeningHoursSpecification",
  "PropertyValue", "MonetaryAmount", "PriceSpecification",
  "UnitPriceSpecification",
]);

// ---------------------------------------------------------------------------
// Pass 1 — merge nodes that share an @id
// ---------------------------------------------------------------------------

function mergeById(entities: Entity[], issues: ValidationIssue[]): Entity[] {
  const byId = new Map<string, Entity>();
  const out: Entity[] = [];

  for (const e of entities) {
    if (!e.id) { out.push(e); continue; }
    const existing = byId.get(e.id);
    if (!existing) {
      byId.set(e.id, e);
      out.push(e);
      continue;
    }

    if (typesCompatible(allTypes(existing), allTypes(e))) {
      mergeInto(existing, e);
      issues.push({
        level: "info",
        subject: e.id,
        message: `Merged ${primaryType(e)} into existing node with the same @id.`,
      });
    } else {
      // Two unrelated concepts were given the same @id (usually the LLM reusing
      // an id it shouldn't). Keep the first node; drop the conflicting one —
      // it can only corrupt the node it collides with.
      issues.push({
        level: "warning",
        subject: e.id,
        message:
          `Dropped a ${primaryType(e)} node that reused the @id of an unrelated ` +
          `${primaryType(existing)} node.`,
      });
    }
  }
  return out;
}

/** Can two nodes at the same @id be safely merged into one? */
function typesCompatible(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return true;
  const A = new Set(a);
  const B = new Set(b);
  if ([...A].every((t) => B.has(t)) || [...B].every((t) => A.has(t))) return true;
  for (const family of [ARTICLE_TYPES, PAGE_TYPES]) {
    if (a.some((t) => family.has(t)) && b.some((t) => family.has(t))) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Pass 2 — collapse a type family to one node per page
// ---------------------------------------------------------------------------

function collapseFamily(
  entities: Entity[],
  family: Set<string>,
  label: "page" | "article",
  pageUrl: string | undefined,
  issues: ValidationIssue[],
): Entity[] {
  const target = normUrl(pageUrl);

  const members = entities.filter((e) => allTypes(e).some((t) => family.has(t)));
  if (members.length < 2) return entities;

  // Only merge members that belong to *this* page: their own url (or
  // mainEntityOfPage / isPartOf) points at the page, or they carry no
  // identifying url of their own.
  const belongsToPage = (e: Entity): boolean => {
    const own = normUrl(str(e.props["url"]));
    if (own) return !target || own === target;
    const mop = normUrl(refUrl(e.props["mainEntityOfPage"]) ?? refUrl(e.props["isPartOf"]));
    if (mop && target) return mop === target;
    return true; // no identity of its own → assume it's this page
  };

  const toMerge = members.filter(belongsToPage);
  if (toMerge.length < 2) return entities;

  const primary = pickFamilyPrimary(toMerge);
  for (const e of toMerge) {
    if (e === primary) continue;
    mergeInto(primary, e);
  }
  primary.type = unionTypes(toMerge.flatMap(allTypes), family);

  issues.push({
    level: "info",
    subject: primary.id ?? primaryType(primary),
    message:
      `Collapsed ${toMerge.length} ${label} nodes (${[...new Set(toMerge.map(primaryType))].join(", ")}) ` +
      `into one — they describe the same ${label}.`,
  });

  const dropped = new Set(toMerge.filter((e) => e !== primary));
  return entities.filter((e) => !dropped.has(e));
}

/** Prefer a node that already has a stable id (from existing markup / registry). */
function pickFamilyPrimary(members: Entity[]): Entity {
  return (
    members.find((e) => e._source === "existing" && e.id) ??
    members.find((e) => e.id) ??
    members[0]!
  );
}

/**
 * Build the final @type: keep every distinct family member, most-generic first
 * removed when a more specific sibling is present. "Article" is dropped when any
 * other article type is present; "WebPage" is kept as the base page type.
 */
function unionTypes(types: string[], family: Set<string>): string | string[] {
  const uniq = [...new Set(types)];
  const fam = uniq.filter((t) => family.has(t));
  const nonFam = uniq.filter((t) => !family.has(t));

  let famOut = fam;
  if (family === ARTICLE_TYPES && fam.length > 1) {
    famOut = fam.filter((t) => t !== "Article");
  }
  if (family === PAGE_TYPES) {
    // WebPage first, then the rest in a stable order.
    famOut = [
      ...(fam.includes("WebPage") ? ["WebPage"] : []),
      ...fam.filter((t) => t !== "WebPage").sort(),
    ];
  }

  const all = [...famOut, ...nonFam];
  return all.length === 1 ? all[0]! : all;
}

// ---------------------------------------------------------------------------
// Pass 3 — reference integrity
// ---------------------------------------------------------------------------

const DROP = Symbol("drop-unresolvable-ref");

function fixReferences(entities: Entity[], issues: ValidationIssue[]): void {
  const idSet = new Set<string>();
  const byUrl = new Map<string, string>();
  const bySlug = new Map<string, string>();

  for (const e of entities) {
    if (!e.id) continue;
    idSet.add(e.id);
    const slug = slugOf(e.id);
    if (slug && !bySlug.has(slug)) bySlug.set(slug, e.id);
    const u = normUrl(str(e.props["url"]));
    if (u && !byUrl.has(u)) byUrl.set(u, e.id);
  }

  // Ids defined on *inline* nodes (objects carrying their own @type + props)
  // count as resolvable targets too — a { "@id": X } pointer to an inline
  // ImageObject is valid JSON-LD even though X is not a top-level graph node.
  for (const e of entities) {
    for (const v of Object.values(e.props)) collectInlineIds(v, idSet);
  }

  const resolve = (rawId: string): string | undefined => {
    if (idSet.has(rawId)) return rawId;
    // A fragment identifier (…/#foo) IS the identity — never fall back to
    // matching it against a node's plain url, or "…/#/schema/logo/image/"
    // would resolve to the homepage. Only same-fragment slug matching applies.
    const hasFragment = rawId.includes("#");
    if (!hasFragment) {
      const u = normUrl(rawId);
      if (u && byUrl.has(u)) return byUrl.get(u);
    }
    const slug = slugOf(rawId);
    if (slug && slug.startsWith("#") && bySlug.has(slug)) return bySlug.get(slug);
    return undefined;
  };

  /**
   * A "thin reference": a pointer to another node, not a node in its own right.
   * `{ "@id": X }`, optionally with a display-only `name`/`url`. Anything with
   * `@type` or real content properties is an inline node and is left untouched
   * (its `@id` may legitimately not be a top-level graph node).
   */
  const isThinReference = (obj: Record<string, unknown>): boolean => {
    if (typeof obj["@id"] !== "string") return false;
    if ("@type" in obj) return false;
    const soft = new Set(["@id", "name", "url"]);
    return Object.keys(obj).every((k) => soft.has(k));
  };

  const walk = (value: unknown, subject: string): unknown | typeof DROP => {
    if (Array.isArray(value)) {
      const mapped = value
        .map((v) => walk(v, subject))
        .filter((v) => v !== DROP);
      return mapped;
    }
    if (value && typeof value === "object") {
      const obj = value as Record<string, unknown>;
      const ref = obj["@id"];

      if (typeof ref === "string" && !ref.startsWith("_:") && isThinReference(obj)) {
        const resolved = resolve(ref);
        if (resolved) {
          if (resolved !== ref) {
            obj["@id"] = resolved;
            issues.push({
              level: "info",
              subject,
              message: `Rewired dangling @id reference "${ref}" → "${resolved}".`,
            });
          }
        } else if (Object.keys(obj).length > 1) {
          delete obj["@id"];
          issues.push({
            level: "warning",
            subject,
            message: `Dropped unresolvable @id "${ref}" but kept the inline value.`,
          });
        } else {
          issues.push({
            level: "warning",
            subject,
            message: `Removed reference to unresolvable @id "${ref}".`,
          });
          return DROP;
        }
      }

      for (const [k, v] of Object.entries(obj)) {
        const r = walk(v, subject);
        if (r === DROP) delete obj[k];
        else obj[k] = r;
      }
      return obj;
    }
    return value;
  };

  for (const e of entities) {
    const subject = e.id ?? primaryType(e);
    for (const [k, v] of Object.entries(e.props)) {
      const r = walk(v, subject);
      if (r === DROP) delete e.props[k];
      else e.props[k] = r;
    }
  }
}

// ---------------------------------------------------------------------------
// Pass 4 — prune subordinate nodes that nothing references
// ---------------------------------------------------------------------------

function pruneOrphans(entities: Entity[], issues: ValidationIssue[]): Entity[] {
  const referenced = new Set<string>();
  const collect = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(collect);
    if (v && typeof v === "object") {
      const ref = (v as Record<string, unknown>)["@id"];
      if (typeof ref === "string") referenced.add(ref);
      Object.values(v as Record<string, unknown>).forEach(collect);
    }
  };
  for (const e of entities) Object.values(e.props).forEach(collect);

  return entities.filter((e) => {
    const isSubordinate = allTypes(e).every((t) => SUBORDINATE_TYPES.has(t));
    if (!isSubordinate) return true;
    if (!e.id || referenced.has(e.id)) return true;
    if (e._source === "existing") return true;
    issues.push({
      level: "info",
      subject: e.id,
      message: `Pruned unreferenced ${primaryType(e)} node.`,
    });
    return false;
  });
}

// ---------------------------------------------------------------------------
// Merge helpers
// ---------------------------------------------------------------------------

/** Merge `extra` into `base`: base keeps its non-empty values; arrays are unioned. */
function mergeInto(base: Entity, extra: Entity): void {
  base.type = mergeTypeList(base.type, extra.type);
  if (!base.id && extra.id) base.id = extra.id;
  for (const [k, v] of Object.entries(extra.props)) {
    const cur = base.props[k];
    if (cur == null || cur === "") {
      base.props[k] = v;
    } else if (Array.isArray(cur) || Array.isArray(v)) {
      base.props[k] = unionArray(cur, v);
    }
    // else: keep base's scalar value
  }
}

function mergeTypeList(
  a: string | string[],
  b: string | string[],
): string | string[] {
  const all = [...new Set([...toArr(a), ...toArr(b)])];
  return all.length === 1 ? all[0]! : all;
}

function unionArray(a: unknown, b: unknown): unknown[] {
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const item of [...toArr(a), ...toArr(b)]) {
    const key =
      item && typeof item === "object" && "@id" in (item as object)
        ? `@id:${(item as Record<string, unknown>)["@id"]}`
        : JSON.stringify(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function cloneEntity(e: Entity): Entity {
  return {
    id: e.id,
    type: Array.isArray(e.type) ? [...e.type] : e.type,
    props: structuredClone(e.props),
    _key: e._key,
    _source: e._source,
  };
}

function toArr<T>(v: T | T[]): T[] {
  return Array.isArray(v) ? v : [v];
}

/** Walk a value and add every inline-node @id (object with @id AND @type) to `into`. */
function collectInlineIds(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const v of value) collectInlineIds(v, into);
    return;
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj["@id"] === "string" && "@type" in obj) into.add(obj["@id"]);
    for (const v of Object.values(obj)) collectInlineIds(v, into);
  }
}

function allTypes(e: Entity): string[] {
  return toArr(e.type).filter((t): t is string => typeof t === "string");
}

function primaryType(e: Entity): string {
  return allTypes(e)[0] ?? "Thing";
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/** A url-ish value that may be a bare string or a { "@id" } / { url } object. */
function refUrl(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return str(o["@id"]) ?? str(o["url"]);
  }
  return undefined;
}

/** Normalize a URL for comparison: drop protocol, fragment, trailing slash, lowercase. */
function normUrl(u: string | undefined): string | undefined {
  if (!u) return undefined;
  return u
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/#.*$/, "")
    .replace(/\/+$/, "");
}

/** The fragment or last path segment of an id, for slug-based reference matching. */
function slugOf(id: string): string | undefined {
  const hash = id.match(/#([\w-]+)$/);
  if (hash && hash[1]) return `#${hash[1]}`;
  const seg = normUrl(id)?.split("/").filter(Boolean).pop();
  if (!seg || seg.includes(".")) return undefined;
  return seg;
}
