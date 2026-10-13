import {
  DEFAULT_MODEL,
  DEFAULT_BLOCKED_SITES,
  DEFAULT_LOCAL_BASE_URL,
  DEFAULT_PROVIDER,
  MODEL_CHOICES,
  PROVIDER_CHOICES,
  STORAGE_KEYS as AGENT_KEYS,
  type HomepageModel,
  type KVStore,
  type ProviderId,
} from "@homepage/agent-core";

/**
 * Everything the extension persists, in one place. All of it lives in
 * chrome.storage.local — including the API key, which anyone with access to the
 * browser profile can read. Fine for a tool you run yourself; not for one you
 * distribute (see ARCHITECTURE.md → Privacy).
 */
export const KEYS = {
  ...AGENT_KEYS,
  homepage: "homepageData",
  systemPrompt: "systemPrompt",
  blockedSites: "blockedSites",
  model: "model",
  provider: "provider",
  localBaseUrl: "localBaseUrl",
  localModel: "localModel",
  localApiKey: "localApiKey",
  autoRebuild: "autoRebuild",
  /** ISO timestamp of the last auto-build *attempted* (success or not). */
  lastAutoBuildAttempt: "lastAutoBuildAttempt",
  rebuildIntervalHours: "autoRebuildIntervalHours",
  /** Throttled mirror of the live build state, for tabs that open while the worker sleeps. */
  buildSnapshot: "buildSnapshot",
} as const;

export interface Homepage {
  /** The agent's raw TSX source. */
  code: string;
  /** ISO timestamp of when it was built. */
  timestamp: string;
}

export interface Settings {
  apiKey: string | null;
  systemPrompt: string;
  blockedSites: string[];
  model: HomepageModel;
  /** Which engine builds the homepage. */
  provider: ProviderId;
  /** OpenAI-compatible base URL of the local server, e.g. http://localhost:11434/v1. */
  localBaseUrl: string;
  /** Model name as the local server knows it; null until one is picked. */
  localModel: string | null;
  /** Bearer token for the local server; null when it needs none. */
  localApiKey: string | null;
  /** Unset means on — auto-rebuild is opt-out. */
  autoRebuild: boolean;
  rebuildIntervalHours: number | null;
}

/** The `KVStore` agent-core persists its agent/environment/session IDs through. */
export const extensionStore: KVStore = {
  async get<T>(key: string): Promise<T | undefined> {
    const result = await browser.storage.local.get(key);
    return result[key] as T | undefined;
  },
  async set(key: string, value: unknown): Promise<void> {
    await browser.storage.local.set({ [key]: value });
  },
  async remove(key: string): Promise<void> {
    await browser.storage.local.remove(key);
  },
};

export async function loadSettings(): Promise<Settings> {
  const s = await browser.storage.local.get([
    KEYS.apiKey,
    KEYS.systemPrompt,
    KEYS.blockedSites,
    KEYS.model,
    KEYS.provider,
    KEYS.localBaseUrl,
    KEYS.localModel,
    KEYS.localApiKey,
    KEYS.autoRebuild,
    KEYS.rebuildIntervalHours,
  ]);
  const model = s[KEYS.model] as string | undefined;
  const provider = s[KEYS.provider] as string | undefined;
  return {
    apiKey: (s[KEYS.apiKey] as string | undefined) ?? null,
    systemPrompt: (s[KEYS.systemPrompt] as string | undefined) ?? "",
    blockedSites: (s[KEYS.blockedSites] as string[] | undefined) ?? [...DEFAULT_BLOCKED_SITES],
    // Fall back if a stored model is no longer offered.
    model: MODEL_CHOICES.find((m) => m.id === model)?.id ?? DEFAULT_MODEL,
    provider: PROVIDER_CHOICES.find((p) => p.id === provider)?.id ?? DEFAULT_PROVIDER,
    localBaseUrl: (s[KEYS.localBaseUrl] as string | undefined) || DEFAULT_LOCAL_BASE_URL,
    localModel: (s[KEYS.localModel] as string | undefined) || null,
    localApiKey: (s[KEYS.localApiKey] as string | undefined) || null,
    autoRebuild: s[KEYS.autoRebuild] !== false,
    rebuildIntervalHours: (s[KEYS.rebuildIntervalHours] as number | undefined) ?? null,
  };
}

export type SettingKey = keyof Settings;

export async function saveSetting<K extends SettingKey>(
  key: K,
  value: Settings[K],
): Promise<void> {
  await browser.storage.local.set({ [KEYS[key]]: value });
}

/** Whether the chosen engine has what it needs to start a build. */
export function isConfigured(settings: Pick<Settings, "provider" | "apiKey" | "localModel">): boolean {
  return settings.provider === "local" ? Boolean(settings.localModel) : Boolean(settings.apiKey);
}

export async function loadHomepage(): Promise<Homepage | undefined> {
  return extensionStore.get<Homepage>(KEYS.homepage);
}

export async function saveHomepage(code: string): Promise<void> {
  const homepage: Homepage = { code, timestamp: new Date().toISOString() };
  await extensionStore.set(KEYS.homepage, homepage);
}
