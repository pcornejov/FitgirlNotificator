import type { SeenReleasesKV } from "../src/store";

interface StoredEntry {
  value: string;
  expirationTtl?: number;
}

/** In-memory stand-in for the `SEEN_RELEASES` KV namespace. */
export class MemoryKV implements SeenReleasesKV {
  readonly entries = new Map<string, StoredEntry>();
  failNextPut: Error | null = null;
  failNextGet: Error | null = null;
  getCalls = 0;
  putCalls = 0;

  async get(key: string): Promise<string | null> {
    this.getCalls += 1;
    if (this.failNextGet !== null) {
      const error = this.failNextGet;
      this.failNextGet = null;
      throw error;
    }
    return this.entries.get(key)?.value ?? null;
  }

  async put(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void> {
    this.putCalls += 1;
    if (this.failNextPut !== null) {
      const error = this.failNextPut;
      this.failNextPut = null;
      throw error;
    }
    this.entries.set(key, { value, expirationTtl: options?.expirationTtl });
  }

  seed(...keys: string[]): void {
    for (const key of keys) {
      this.entries.set(key, { value: new Date().toISOString() });
    }
  }
}
