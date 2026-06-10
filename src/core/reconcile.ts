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
  const base = (input.canonicalUrl || input.sourceUrl || "urn:schemaforge")
    .replace(/#.*$/, "")
    .replace(/\/$/, "");

  // 1) Compute a reconciliation key for each entity.
  for (const e of entities) e._key = e._key || keyFor(e);

  // 2) Merge entities that share a key within this run.
  const byKey = new Map<string, Entity>();
  for (const e of entities) {
    const existing = byKey.get(e._key!);
    if (existing) {
      existing.props = mergeProps(existing.props, e.props);
      existing.type = preferSpecificType(existing.type, e.type);
      if (!existing.id && e.id) existing.id = e.id;
    } else {
      byKey.set(e._key!, { ...e });
    }
  }

  // 3) Resolve @id from registry (stability only) then mint if new.
  const result: Entity[] = [];
  for (const e of byKey.values()) {
    const reg = registry.resolve(e._key!);

    if (!e.id) {
      e.id = reg?.id || mintId(base, e);
    }

    registry.upsert({
      key: e._key!,
      id: e.id,
      type: e.type,
      name: typeof e.props["name"] === "string" ? (e.props["name"] as string) : undefined,
    });

    result.push(e);
  }

  return { entities: result };
}

// WebPage-family types are canonically identified by URL, not by name.
const WEB_PAGE_TYPES = new Set([
  "WebPage", "AboutPage", "ContactPage", "FAQPage", "ProfilePage",
  "CollectionPage", "ItemPage", "SearchResultsPage", "CheckoutPage",
]);

/**
 * Deterministic reconciliation key: always type + normalized identifier.
 * sameAs is intentionally NOT used as a key — hallucinated sameAs URLs from the
 * LLM would otherwise fragment the registry into dozens of separate entries for
 * the same real-world entity.
 */
function keyFor(e: Entity): string {
  const primaryType = Array.isArray(e.type) ? e.type[0] : e.type;

  if (primaryType && WEB_PAGE_TYPES.has(primaryType) && typeof e.props["url"] === "string") {
    return `${primaryType}:${normalize(e.props["url"] as string)}`;
  }

  const name =
    typeof e.props["name"] === "string"
      ? (e.props["name"] as string)
      : typeof e.props["url"] === "string"
        ? (e.props["url"] as string)
        : JSON.stringify(e.props).slice(0, 40);
  return `${primaryType}:${normalize(name)}`;
}

/** Mint a stable, content-derived fragment id under the page base. */
function mintId(base: string, e: Entity): string {
  const primaryType = (Array.isArray(e.type) ? e.type[0] : e.type) || "thing";
  const h = createHash("sha1").update(e._key!).digest("hex").slice(0, 8);
  return `${base}/#${primaryType.toLowerCase()}-${h}`;
}

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

function preferSpecificType(
  a: string | string[],
  b: string | string[],
): string | string[] {
  const al = Array.isArray(a) ? a : [a];
  const bl = Array.isArray(b) ? b : [b];
  return bl.length > al.length ? b : a;
}

function normalize(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
