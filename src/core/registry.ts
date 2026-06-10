import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";

/**
 * The "memory". A persistent store that maps a canonical entity key
 * (normalized name + type, or a sameAs URI) to a stable @id and the union of
 * known properties. This is what lets the same municipality / organization /
 * author keep ONE @id across many pages instead of getting a fresh id each run.
 *
 * v1 is JSON-file backed behind an interface; we can swap in SQLite later
 * without touching callers.
 */
export interface RegistryEntry {
  key: string;
  id: string; // stable @id (IRI)
  type: string | string[];
  name?: string;
  sameAs?: string[];
  /** Merged property knowledge accumulated over runs. */
  props: Record<string, unknown>;
  firstSeen: string;
  lastSeen: string;
}

export interface Registry {
  resolve(key: string): RegistryEntry | undefined;
  resolveBySameAs(uri: string): RegistryEntry | undefined;
  upsert(entry: Omit<RegistryEntry, "firstSeen" | "lastSeen">): RegistryEntry;
  all(): RegistryEntry[];
  flush(): Promise<void>;
}

export class JsonRegistry implements Registry {
  private byKey = new Map<string, RegistryEntry>();
  private bySameAs = new Map<string, string>(); // sameAs uri -> key

  private constructor(private path: string) {}

  static async open(path: string): Promise<JsonRegistry> {
    const reg = new JsonRegistry(path);
    if (existsSync(path)) {
      const data = JSON.parse(await readFile(path, "utf8")) as RegistryEntry[];
      for (const e of data) {
        reg.byKey.set(e.key, e);
        for (const s of e.sameAs || []) reg.bySameAs.set(s, e.key);
      }
    }
    return reg;
  }

  resolve(key: string): RegistryEntry | undefined {
    return this.byKey.get(key);
  }

  resolveBySameAs(uri: string): RegistryEntry | undefined {
    const key = this.bySameAs.get(uri);
    return key ? this.byKey.get(key) : undefined;
  }

  upsert(input: Omit<RegistryEntry, "firstSeen" | "lastSeen">): RegistryEntry {
    const now = new Date().toISOString();
    const existing = this.byKey.get(input.key);
    const merged: RegistryEntry = existing
      ? {
          ...existing,
          ...input,
          // never lose the original stable id
          id: existing.id,
          props: { ...existing.props, ...input.props },
          sameAs: dedupe([...(existing.sameAs || []), ...(input.sameAs || [])]),
          lastSeen: now,
        }
      : { ...input, firstSeen: now, lastSeen: now };

    this.byKey.set(merged.key, merged);
    for (const s of merged.sameAs || []) this.bySameAs.set(s, merged.key);
    return merged;
  }

  all(): RegistryEntry[] {
    return [...this.byKey.values()];
  }

  async flush(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(this.all(), null, 2), "utf8");
  }
}

function dedupe<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}
