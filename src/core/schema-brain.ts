import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

/**
 * The "schema-brain": the full schema.org vocabulary, loaded from the official
 * JSON-LD dump (run `pnpm fetch:schema`). It knows the type hierarchy
 * (subClassOf), which properties exist, and which types each property is valid
 * for (domainIncludes) and what it ranges over (rangeIncludes).
 *
 * If the dump is not present, the brain degrades to a lenient mode: it still
 * works, but type/property validation only emits soft warnings.
 */
export interface PropertyInfo {
  id: string; // e.g. "schema:containedInPlace"
  label: string; // e.g. "containedInPlace"
  domainIncludes: string[]; // type labels this property applies to
  rangeIncludes: string[]; // type labels this property can point to
  comment?: string;
}

export interface TypeInfo {
  id: string;
  label: string;
  subClassOf: string[]; // direct parents (labels)
  comment?: string;
}

export class SchemaBrain {
  readonly loaded: boolean;
  private types = new Map<string, TypeInfo>();
  private props = new Map<string, PropertyInfo>();
  /** label -> property labels valid for that type (including inherited). */
  private propsByType = new Map<string, Set<string>>();

  private constructor(loaded: boolean) {
    this.loaded = loaded;
  }

  static async load(dumpPath: string): Promise<SchemaBrain> {
    if (!existsSync(dumpPath)) {
      console.warn(
        `[schema-brain] dump not found at ${dumpPath} — running in lenient mode. Run "pnpm fetch:schema".`,
      );
      return new SchemaBrain(false);
    }
    const raw = await readFile(dumpPath, "utf8");
    const doc = JSON.parse(raw);
    const brain = new SchemaBrain(true);
    brain.ingest(doc["@graph"] || []);
    brain.buildPropertyIndex();
    return brain;
  }

  private ingest(graph: any[]): void {
    for (const node of graph) {
      const types = asArray(node["@type"]).map(stripPrefix);
      const label = stripPrefix(node["@id"]);
      if (types.includes("rdfs:Class") || types.includes("Class")) {
        this.types.set(label, {
          id: node["@id"],
          label,
          subClassOf: asArray(node["rdfs:subClassOf"]).map((x) =>
            stripPrefix(idOf(x)),
          ),
          comment: textOf(node["rdfs:comment"]),
        });
      } else if (types.includes("rdf:Property") || types.includes("Property")) {
        this.props.set(label, {
          id: node["@id"],
          label,
          domainIncludes: asArray(node["schema:domainIncludes"]).map((x) =>
            stripPrefix(idOf(x)),
          ),
          rangeIncludes: asArray(node["schema:rangeIncludes"]).map((x) =>
            stripPrefix(idOf(x)),
          ),
          comment: textOf(node["rdfs:comment"]),
        });
      }
    }
  }

  private buildPropertyIndex(): void {
    // For each property, attach it to every type in its domain plus all
    // subclasses of those types.
    for (const prop of this.props.values()) {
      for (const domain of prop.domainIncludes) {
        for (const sub of this.subTypesOf(domain)) {
          if (!this.propsByType.has(sub)) this.propsByType.set(sub, new Set());
          this.propsByType.get(sub)!.add(prop.label);
        }
      }
    }
  }

  /** All known types (labels). Useful to feed the LLM allowed-type list. */
  allTypes(): string[] {
    return [...this.types.keys()];
  }

  hasType(label: string): boolean {
    return !this.loaded || this.types.has(label);
  }

  /** Returns true if the type chain of `child` reaches `ancestor`. */
  isSubTypeOf(child: string, ancestor: string): boolean {
    if (child === ancestor) return true;
    const seen = new Set<string>();
    const stack = [child];
    while (stack.length) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const t = this.types.get(cur);
      if (!t) continue;
      if (t.subClassOf.includes(ancestor)) return true;
      stack.push(...t.subClassOf);
    }
    return false;
  }

  /** All subtypes (labels) of a type, inclusive. */
  subTypesOf(label: string): string[] {
    const out = new Set<string>([label]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const t of this.types.values()) {
        if (out.has(t.label)) continue;
        if (t.subClassOf.some((p) => out.has(p))) {
          out.add(t.label);
          changed = true;
        }
      }
    }
    return [...out];
  }

  /** Is `property` valid on `type` (considering inheritance)? Lenient if unloaded. */
  isPropertyValidFor(property: string, type: string): boolean {
    if (!this.loaded) return true;
    // Always-allowed JSON-LD / schema housekeeping keys.
    if (property.startsWith("@")) return true;
    const set = this.propsByType.get(type);
    if (!set) return false;
    return set.has(property);
  }

  /** Recommended property labels for a type (the universe of valid props). */
  propertiesFor(type: string): string[] {
    return [...(this.propsByType.get(type) || [])].sort();
  }

  getProperty(label: string): PropertyInfo | undefined {
    return this.props.get(label);
  }
}

function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}
function idOf(x: any): string {
  return typeof x === "string" ? x : x?.["@id"] || "";
}
function stripPrefix(id: string): string {
  return id.replace(/^schema:/, "").replace(/^https?:\/\/schema\.org\//, "");
}
function textOf(v: any): string | undefined {
  if (!v) return undefined;
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return textOf(v[0]);
  return v["@value"] || undefined;
}
