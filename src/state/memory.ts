import type { StateStore } from "./state-store.js";

interface Entry { value: string; expiresAt?: number }

export class MemoryStateStore implements StateStore {
  readonly #entries = new Map<string, Entry>();
  #nextSweepAt = 0;

  get(key: string): Promise<string | undefined> {
    return Promise.resolve(this.#get(key));
  }

  #get(key: string): string | undefined {
    this.#sweepExpired();
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
      this.#entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    this.#sweepExpired();
    this.#entries.set(key, { value, ...(ttlSeconds === undefined ? {} : { expiresAt: Date.now() + ttlSeconds * 1_000 }) });
    return Promise.resolve();
  }

  setIfAbsent(key: string, value: string, ttlSeconds?: number): Promise<boolean> {
    if (this.#get(key) !== undefined) return Promise.resolve(false);
    this.#entries.set(key, { value, ...(ttlSeconds === undefined ? {} : { expiresAt: Date.now() + ttlSeconds * 1_000 }) });
    return Promise.resolve(true);
  }

  increment(key: string, ttlSeconds?: number): Promise<number> {
    const stored = this.#get(key);
    const previous = stored === undefined ? 0 : Number(stored);
    if (!Number.isSafeInteger(previous) || previous < 0) return Promise.reject(new Error("State counter is invalid"));
    const current = previous + 1;
    if (!Number.isSafeInteger(current)) return Promise.reject(new Error("State counter overflow"));
    this.#entries.set(key, { value: String(current), ...(ttlSeconds === undefined ? {} : { expiresAt: Date.now() + ttlSeconds * 1_000 }) });
    return Promise.resolve(current);
  }

  delete(key: string): Promise<void> { this.#entries.delete(key); return Promise.resolve(); }
  close(): Promise<void> { this.#entries.clear(); return Promise.resolve(); }

  #sweepExpired(): void {
    const now = Date.now();
    if (now < this.#nextSweepAt) return;
    this.#nextSweepAt = now + 60_000;
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAt !== undefined && entry.expiresAt <= now) this.#entries.delete(key);
    }
  }
}
