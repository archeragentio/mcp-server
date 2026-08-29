import Redis from "ioredis";
import type { StateStore } from "./state-store.js";

export class ValkeyStateStore implements StateStore {
  readonly #redis: Redis;
  constructor(url: string, keyPrefix = "archer-protocol-gateway:") {
    this.#redis = new Redis(url, { keyPrefix, lazyConnect: true, maxRetriesPerRequest: 2 });
  }
  async get(key: string): Promise<string | undefined> { return (await this.#redis.get(key)) ?? undefined; }
  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds === undefined) await this.#redis.set(key, value);
    else await this.#redis.set(key, value, "EX", ttlSeconds);
  }
  async setIfAbsent(key: string, value: string, ttlSeconds?: number): Promise<boolean> {
    const result = ttlSeconds === undefined
      ? await this.#redis.set(key, value, "NX")
      : await this.#redis.set(key, value, "EX", ttlSeconds, "NX");
    return result === "OK";
  }
  async increment(key: string, ttlSeconds?: number): Promise<number> {
    const pipeline = this.#redis.multi().incr(key);
    if (ttlSeconds !== undefined) pipeline.expire(key, ttlSeconds, "NX");
    const result = await pipeline.exec();
    if (!result || result.length === 0) throw new Error("Valkey increment transaction returned no result");
    for (const [error] of result) if (error) throw error;
    const count = Number(result[0]?.[1]);
    if (!Number.isSafeInteger(count) || count < 1) throw new Error("Valkey increment returned an invalid count");
    return count;
  }
  async delete(key: string): Promise<void> { await this.#redis.del(key); }
  async close(): Promise<void> { await this.#redis.quit(); }
}
