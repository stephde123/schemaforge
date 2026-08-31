import type { EntityGraph, Entity, ValidationReport, ValidationIssue } from "./types.js";
import type { SchemaBrain } from "./schema-brain.js";

/**
 * Validate the graph against (a) the schema brain (type exists? property valid
 * for type?) and (b) a small table of Google rich-results required properties.
 * Produces issues + a rough coverage score.
 */

// Minimal subset of Google's required-property table. Extend over time.
const GOOGLE_REQUIRED: Record<string, string[]> = {
  Recipe: ["name", "image"],
  Product: ["name"],
  Event: ["name", "startDate", "location"],
  JobPosting: ["title", "datePosted", "hiringOrganization"],
  LocalBusiness: ["name", "address"],
  Organization: ["name"],
  Article: ["headline"],
  BreadcrumbList: ["itemListElement"],
  FAQPage: ["mainEntity"],
};

export function validate(
  graph: EntityGraph,
  brain: SchemaBrain,
): ValidationReport {
  const issues: ValidationIssue[] = [];
  const missingRequired: Record<string, string[]> = {};
  let validPropTotal = 0;
  let recommendedTotal = 0;

  for (const e of graph.entities) {
    const types = Array.isArray(e.type) ? e.type : [e.type];
    const subject = e.id || types.join(",");

    for (const t of types) {
      if (!brain.hasType(t)) {
        issues.push({
          level: brain.loaded ? "error" : "warning",
          subject,
          message: `Unknown schema.org type "${t}".`,
        });
        continue;
      }

      // Property validity.
      for (const prop of Object.keys(e.props)) {
        if (prop.startsWith("@")) continue;
        if (!brain.isPropertyValidFor(prop, t)) {
          issues.push({
            level: "warning",
            subject,
            message: `Property "${prop}" is not valid for type "${t}".`,
          });
        }
      }

      // Google required props.
      const required = GOOGLE_REQUIRED[t];
      if (required) {
        const missing = required.filter((p) => !(p in e.props));
        if (missing.length) {
          missingRequired[t] = missing;
          issues.push({
            level: "error",
            subject,
            message: `Type "${t}" is missing required-for-rich-results: ${missing.join(", ")}.`,
          });
        }
      }

      // Coverage: how many of the recommended props are present.
      if (brain.loaded) {
        const universe = brain.propertiesFor(t);
        if (universe.length) {
          recommendedTotal += Math.min(universe.length, 20);
          const present = Object.keys(e.props).filter((p) => universe.includes(p));
          validPropTotal += Math.min(present.length, 20);
        }
      }
    }
  }

  if (graph.entities.length === 0) {
    issues.push({ level: "error", message: "No entities produced." });
  }

  issues.push(...checkGraphIntegrity(graph.entities));

  const coverageScore =
    recommendedTotal > 0 ? +(validPropTotal / recommendedTotal).toFixed(2) : 0;

  return { issues, coverageScore, missingRequired };
}

// ---------------------------------------------------------------------------
// Structural integrity checks — independent of the schema vocabulary.
// These catch the failure modes that arise from merging three entity sources
// (existing markup + deterministic + LLM): id collisions, dangling references,
// duplicated primary entities, and mis-typed article pages.
// ---------------------------------------------------------------------------

const ARTICLE_TYPES = new Set([
  "Article", "BlogPosting", "NewsArticle", "TechArticle", "Report",
  "ScholarlyArticle", "SocialMediaPosting", "LiveBlogPosting",
  "AnalysisNewsArticle", "OpinionNewsArticle", "ReviewNewsArticle",
  "BackgroundNewsArticle", "ReportageNewsArticle",
]);

const PRODUCTISH_TYPES = new Set([
  "SoftwareApplication", "WebApplication", "MobileApplication", "Product",
  "Service",
]);

function checkGraphIntegrity(entities: Entity[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const types = (e: Entity): string[] =>
    (Array.isArray(e.type) ? e.type : [e.type]).filter(
      (t): t is string => typeof t === "string",
    );
  const primary = (e: Entity): string => types(e)[0] ?? "Thing";

  // 1) Duplicate @id.
  const ids = new Map<string, number>();
  for (const e of entities) {
    if (e.id) ids.set(e.id, (ids.get(e.id) ?? 0) + 1);
  }
  for (const [id, count] of ids) {
    if (count > 1) {
      issues.push({
        level: "error",
        subject: id,
        message: `${count} nodes share the same @id — a JSON-LD parser will silently merge them.`,
      });
    }
  }

  // 2) Dangling @id references. Only *thin* references (a bare { "@id": … }
  //    pointer, no @type) must resolve; an inline node that carries its own
  //    @type + properties defines its @id and is valid JSON-LD on its own.
  const definedIds = new Set([...ids.keys()]);
  const thinRefs = new Set<string>();
  const collectRefs = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(collectRefs);
    if (v && typeof v === "object") {
      const obj = v as Record<string, unknown>;
      const ref = obj["@id"];
      if (typeof ref === "string") {
        if ("@type" in obj) definedIds.add(ref);
        else if (Object.keys(obj).every((k) => k === "@id" || k === "name" || k === "url")) {
          thinRefs.add(ref);
        }
      }
      Object.values(obj).forEach(collectRefs);
    }
  };
  for (const e of entities) Object.values(e.props).forEach(collectRefs);
  for (const ref of thinRefs) {
    if (!definedIds.has(ref) && !ref.startsWith("_:")) {
      issues.push({
        level: "error",
        subject: ref,
        message: `@id reference "${ref}" does not resolve to any node in the graph.`,
      });
    }
  }

  // 3) More than one article-family primary entity.
  const articleNodes = entities.filter((e) =>
    types(e).some((t) => ARTICLE_TYPES.has(t)),
  );
  if (articleNodes.length > 1) {
    issues.push({
      level: "warning",
      message:
        `Graph has ${articleNodes.length} article-type nodes ` +
        `(${articleNodes.map(primary).join(", ")}) — a page normally has one.`,
    });
  }

  // 4) Product/software entity that looks like it was cloned from the article.
  const articleText = new Set<string>();
  const articleImages = new Set<string>();
  for (const e of articleNodes) {
    for (const k of ["headline", "name"]) {
      const val = e.props[k];
      if (typeof val === "string") articleText.add(val.trim().toLowerCase());
    }
    const img = imageUrl(e.props["image"]);
    if (img) articleImages.add(img);
  }
  for (const e of entities) {
    if (!types(e).some((t) => PRODUCTISH_TYPES.has(t))) continue;
    const name = typeof e.props["name"] === "string" ? e.props["name"].trim().toLowerCase() : "";
    const img = imageUrl(e.props["image"]) ?? imageUrl(e.props["screenshot"]);
    if (name && articleText.has(name)) {
      issues.push({
        level: "warning",
        subject: e.id ?? primary(e),
        message: `${primary(e)} name matches the article headline — likely a mis-typed content page, not a real product.`,
      });
    } else if (img && articleImages.has(img)) {
      issues.push({
        level: "warning",
        subject: e.id ?? primary(e),
        message: `${primary(e)} reuses the article's image — verify this is a real product entity.`,
      });
    }
  }

  // 5) The same FAQ question set declared on more than one node.
  const faqSignatures = new Map<string, number>();
  for (const e of entities) {
    const me = e.props["mainEntity"];
    if (!Array.isArray(me) || me.length === 0) continue;
    const names = me
      .map((q) =>
        q && typeof q === "object"
          ? String((q as Record<string, unknown>)["name"] ?? "")
          : "",
      )
      .filter(Boolean)
      .sort();
    if (names.length < 2) continue;
    const sig = names.join("|").toLowerCase();
    faqSignatures.set(sig, (faqSignatures.get(sig) ?? 0) + 1);
  }
  for (const count of faqSignatures.values()) {
    if (count > 1) {
      issues.push({
        level: "warning",
        message: `The same FAQ question set appears on ${count} nodes — Google may treat this as duplicate FAQ markup.`,
      });
    }
  }

  return issues;
}

function imageUrl(v: unknown): string | undefined {
  if (typeof v === "string") return v.trim().toLowerCase();
  if (Array.isArray(v)) return imageUrl(v[0]);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const u = o["url"] ?? o["contentUrl"] ?? o["@id"];
    return typeof u === "string" ? u.trim().toLowerCase() : undefined;
  }
  return undefined;
}
