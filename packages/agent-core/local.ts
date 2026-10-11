/**
 * Which engine builds the homepage. "anthropic" is the hosted Managed Agents
 * path in orchestrator.ts; "local" talks to an OpenAI-compatible server on this
 * machine (Ollama, LM Studio, llama.cpp, vLLM), so history and pages never leave it.
 */
export type ProviderId = "anthropic" | "local";

export const PROVIDER_CHOICES: { id: ProviderId; label: string }[] = [
  { id: "anthropic", label: "Anthropic API" },
  { id: "local", label: "Local model (OpenAI-compatible server)" },
];

export const DEFAULT_PROVIDER: ProviderId = "anthropic";

/** Ollama's OpenAI-compatible endpoint. LM Studio's default is http://localhost:1234/v1. */
export const DEFAULT_LOCAL_BASE_URL = "http://localhost:11434/v1";

/** Trims whitespace and trailing slashes so `${base}/models` is well-formed. */
export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/**
 * The models a local server offers, via the OpenAI-compatible `GET /models`.
 * Throws with a readable message when the server is down or answers oddly, so
 * Settings can show it as-is.
 */
export async function listLocalModels(baseUrl: string, signal?: AbortSignal): Promise<string[]> {
  const url = `${normalizeBaseUrl(baseUrl)}/models`;
  let response: Response;
  try {
    response = await fetch(url, { signal });
  } catch {
    throw new Error(`Couldn't reach ${url}. Is the server running?`);
  }
  if (!response.ok) {
    throw new Error(`${url} answered ${response.status} ${response.statusText}`.trim());
  }
  const body = (await response.json().catch(() => null)) as { data?: { id?: unknown }[] } | null;
  if (!body || !Array.isArray(body.data)) {
    throw new Error(`${url} didn't return an OpenAI-style model list.`);
  }
  return body.data.map((m) => m.id).filter((id): id is string => typeof id === "string").sort();
}
