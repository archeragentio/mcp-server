import type { GatewayConfig } from "../config.js";
import { MemoryStateStore } from "./memory.js";
import type { StateStore } from "./state-store.js";
import { ValkeyStateStore } from "./valkey.js";

export function createStateStore(config: GatewayConfig): StateStore {
  return config.STATE_STORE_URL ? new ValkeyStateStore(config.STATE_STORE_URL, config.STATE_KEY_PREFIX) : new MemoryStateStore();
}
export type { StateStore } from "./state-store.js";
