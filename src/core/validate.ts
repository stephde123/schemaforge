import type { EntityGraph, ValidationReport, ValidationIssue } from "./types.js";
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

  const coverageScore =
    recommendedTotal > 0 ? +(validPropTotal / recommendedTotal).toFixed(2) : 0;

  return { issues, coverageScore, missingRequired };
}
