export interface StateStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  setIfAbsent(key: string, value: string, ttlSeconds?: number): Promise<boolean>;
  increment(key: string, ttlSeconds?: number): Promise<number>;
  delete(key: string): Promise<void>;
  close(): Promise<void>;
}
