import { createHash } from "node:crypto";
import type { Entity, EntityGraph, NormalizedInput } from "./types.js";
import type { Registry } from "./registry.js";

/**
 * Turn a loose list of entities (from existing markup + deterministic + LLM)
 * into a clean graph: dedupe within the run, assign stable @ids, and resolve
 * cross-page entities against the registry so the same municipality / org /
 * author keeps ONE @id everywhere.
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

  // 3) Resolve against registry + mint ids.
  const result: Entity[] = [];
  for (const e of byKey.values()) {
    // Try registry by sameAs first, then by key.
    const sameAs = asArray(e.props["sameAs"]).filter(
      (x): x is string => typeof x === "string",
    );
    let reg =
      sameAs.map((s) => registry.resolveBySameAs(s)).find(Boolean) ||
      registry.resolve(e._key!);

    if (!e.id) {
      e.id = reg?.id || mintId(base, e);
    }

    // Persist/merge knowledge back into the registry (the memory).
    const entry = registry.upsert({
      key: e._key!,
      id: e.id,
      type: e.type,
      name: typeof e.props["name"] === "string" ? (e.props["name"] as string) : undefined,
      sameAs,
      props: e.props,
    });
    // Current run is authoritative; registry only fills properties the current run didn't produce.
    e.props = mergeProps(e.props, entry.props);
    result.push(e);
  }

  return { entities: result };
}

// WebPage-family types are canonically identified by URL, not by name.
// Names can differ across sources due to encoding (e.g. garbled \uXXXX escapes).
const WEB_PAGE_TYPES = new Set([
  "WebPage", "AboutPage", "ContactPage", "FAQPage", "ProfilePage",
  "CollectionPage", "ItemPage", "SearchResultsPage", "CheckoutPage",
]);

/** Deterministic reconciliation key: sameAs URI wins, else type+normalized identifier. */
function keyFor(e: Entity): string {
  const sameAs = asArray(e.props["sameAs"]).find((x) => typeof x === "string");
  if (typeof sameAs === "string") return `sameas:${sameAs}`;
  const primaryType = Array.isArray(e.type) ? e.type[0] : e.type;

  // For WebPage-family types, use URL as the key so all sources for the same page
  // merge correctly regardless of how the name is encoded.
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
  // Prefer the longer/more specific set; cheap heuristic for v1.
  return bl.length > al.length ? b : a;
}

function normalize(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
function asArray<T>(v: T | T[] | undefined): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}
