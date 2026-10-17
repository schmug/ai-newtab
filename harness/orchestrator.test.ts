import { describe, expect, test } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { STORAGE_KEYS, runHomepageBuild, type BrowserBridge, type KVStore } from "@homepage/agent-core";

function memoryStore(initial: Record<string, unknown>): KVStore & { data: Map<string, unknown> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    async get<T>(key: string) {
      return data.get(key) as T | undefined;
    },
    async set(key: string, value: unknown) {
      data.set(key, value);
    },
    async remove(key: string) {
      data.delete(key);
    },
  };
}

/** Every API call fails the way the real API does for a revoked key. */
function revokedKeyClient(): Anthropic {
  const error = () =>
    Object.assign(new Error('401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'), {
      status: 401,
    });
  // Awaited calls reject; paginated `list()` calls are iterated, so fail there too.
  const reject = () => {
    const pending = Promise.reject(error());
    pending.catch(() => {});
    return Object.assign(pending, {
      [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(error()) }),
    });
  };
  const resource = new Proxy({}, { get: () => reject });
  return { beta: new Proxy({}, { get: () => resource }) } as unknown as Anthropic;
}

const noBridge = {} as BrowserBridge;

describe("runHomepageBuild resume", () => {
  test("a rejected key forgets the session so the worker stops resuming it", async () => {
    const store = memoryStore({ [STORAGE_KEYS.activeSessionId]: "sesn_stale" });

    await expect(
      runHomepageBuild({ client: revokedKeyClient(), bridge: noBridge, store, resumeSessionId: "sesn_stale" }),
    ).rejects.toThrow("invalid x-api-key");

    expect(store.data.has(STORAGE_KEYS.activeSessionId)).toBe(false);
  });
});
