import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Lightweight identity store: maps a canonical entity key (type + normalized
 * name, or URL for page types) to a stable @id. This is the only thing worth
 * persisting across runs — it keeps the same Organization/Person/etc. at ONE
 * @id across all pages of a site instead of minting a fresh id each run.
 *
 * Deliberately stores NO properties. Property data stays authoritative per run
 * (what is on the page now) and is never accumulated across runs, which would
 * risk persisting hallucinated or stale values.
 */
export interface RegistryEntry {
  key: string;
  id: string;
  type: string | string[];
  name?: string;
  firstSeen: string;
  lastSeen: string;
}

export interface Registry {
  resolve(key: string): RegistryEntry | undefined;
  upsert(entry: Omit<RegistryEntry, "firstSeen" | "lastSeen">): RegistryEntry;
  all(): RegistryEntry[];
  flush(): Promise<void>;
  clear(): Promise<void>;
}

export class JsonRegistry implements Registry {
  private byKey = new Map<string, RegistryEntry>();

  private constructor(private path: string) {}

  static async open(path: string): Promise<JsonRegistry> {
    const reg = new JsonRegistry(path);
    if (existsSync(path)) {
      const data = JSON.parse(await readFile(path, "utf8")) as RegistryEntry[];
      for (const e of data) {
        reg.byKey.set(e.key, e);
      }
    }
    return reg;
  }

  resolve(key: string): RegistryEntry | undefined {
    return this.byKey.get(key);
  }

  upsert(input: Omit<RegistryEntry, "firstSeen" | "lastSeen">): RegistryEntry {
    const now = new Date().toISOString();
    const existing = this.byKey.get(input.key);
    const entry: RegistryEntry = existing
      ? { ...existing, name: input.name ?? existing.name, lastSeen: now }
      : { ...input, firstSeen: now, lastSeen: now };
    this.byKey.set(entry.key, entry);
    return entry;
  }

  all(): RegistryEntry[] {
    return [...this.byKey.values()];
  }

  async flush(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(this.all(), null, 2), "utf8");
  }

  async clear(): Promise<void> {
    this.byKey.clear();
    await this.flush();
  }
}
