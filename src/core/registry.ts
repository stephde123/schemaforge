import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Lightweight identity store: maps a canonical entity key (see reconcile.keyFor)
 * to a stable @id. This is the only thing worth persisting across runs — it
 * keeps the same Organization/Person/Article/etc. at ONE @id across runs and
 * across the pages of a site instead of minting a fresh id each time.
 *
 * Deliberately stores NO properties. Property data stays authoritative per run
 * (what is on the page now) and is never accumulated, which would risk
 * persisting hallucinated or stale values.
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
  delete(predicate: (e: RegistryEntry) => boolean): number;
  getRunCount(): number;
  bumpRunCount(): void;
  flush(): Promise<void>;
  clear(): Promise<void>;
}

/** On-disk format. v1 was a bare `RegistryEntry[]`. */
interface RegistryFile {
  v: 2;
  runCount: number;
  entries: RegistryEntry[];
}

/** Entries not touched for this long are dropped on load. */
const TTL_MS = 180 * 24 * 60 * 60 * 1000;
/** Hard cap on entry count; oldest-by-lastSeen are dropped past this. */
const MAX_ENTRIES = 20_000;

export class JsonRegistry implements Registry {
  private byKey = new Map<string, RegistryEntry>();
  private runCount = 0;
  /** Serialises concurrent flushes so overlapping writes can't interleave. */
  private writing: Promise<void> = Promise.resolve();

  private constructor(private path: string) {}

  static async open(path: string): Promise<JsonRegistry> {
    const reg = new JsonRegistry(path);

    let raw: unknown;
    if (existsSync(path)) {
      try {
        raw = JSON.parse(await readFile(path, "utf8"));
      } catch (err) {
        console.warn(`[registry] ${path} is unreadable (${err}) — starting empty.`);
      }
    }

    if (Array.isArray(raw)) {
      // v1: bare entry array. The old keying scheme fragmented identities and
      // accumulated reference-stub garbage — not worth migrating. Start clean;
      // ids re-stabilise as pages are re-crawled.
      console.warn(
        `[registry] migrating from v1 — discarding ${raw.length} legacy entries.`,
      );
    } else if (raw && typeof raw === "object" && (raw as RegistryFile).v === 2) {
      const file = raw as RegistryFile;
      reg.runCount = Number.isFinite(file.runCount) ? file.runCount : 0;
      const cutoff = Date.now() - TTL_MS;
      for (const e of file.entries ?? []) {
        if (!e?.key || !e?.id) continue;
        if (Date.parse(e.lastSeen) < cutoff) continue;
        reg.byKey.set(e.key, e);
      }
      reg.evict();
    }

    return reg;
  }

  resolve(key: string): RegistryEntry | undefined {
    return this.byKey.get(key);
  }

  upsert(input: Omit<RegistryEntry, "firstSeen" | "lastSeen">): RegistryEntry {
    const now = new Date().toISOString();
    const existing = this.byKey.get(input.key);
    // @id is frozen once assigned — that IS the stability guarantee. Only name
    // and lastSeen move.
    const entry: RegistryEntry = existing
      ? { ...existing, name: input.name ?? existing.name, lastSeen: now }
      : { ...input, firstSeen: now, lastSeen: now };
    this.byKey.set(entry.key, entry);
    return entry;
  }

  all(): RegistryEntry[] {
    return [...this.byKey.values()];
  }

  delete(predicate: (e: RegistryEntry) => boolean): number {
    let n = 0;
    for (const [key, entry] of this.byKey) {
      if (predicate(entry)) {
        this.byKey.delete(key);
        n++;
      }
    }
    return n;
  }

  getRunCount(): number {
    return this.runCount;
  }

  bumpRunCount(): void {
    this.runCount++;
  }

  /** Drop the oldest entries once past MAX_ENTRIES. */
  private evict(): void {
    if (this.byKey.size <= MAX_ENTRIES) return;
    const sorted = [...this.byKey.values()].sort(
      (a, b) => Date.parse(b.lastSeen) - Date.parse(a.lastSeen),
    );
    this.byKey.clear();
    for (const e of sorted.slice(0, MAX_ENTRIES)) this.byKey.set(e.key, e);
  }

  async flush(): Promise<void> {
    this.evict();
    const body = JSON.stringify(
      { v: 2, runCount: this.runCount, entries: this.all() } satisfies RegistryFile,
      null,
      2,
    );

    // Write to a temp file then atomically rename, so a crash mid-write can
    // never truncate the live file. Chain onto any in-flight write (a failed
    // one doesn't block the next) so overlapping flushes can't interleave.
    const write = async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.${process.pid}.tmp`;
      await writeFile(tmp, body, "utf8");
      await rename(tmp, this.path);
    };
    this.writing = this.writing.catch(() => {}).then(write);
    try {
      await this.writing;
    } catch (err) {
      console.error(`[registry] flush failed: ${err}`);
    }
  }

  async clear(): Promise<void> {
    this.byKey.clear();
    await this.flush();
  }
}
