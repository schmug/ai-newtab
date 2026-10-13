/**
 * Input schemas for the two custom tools. The caps live in the schema, not just
 * the handler, so the model can see the ceiling it is working against.
 */

/**
 * Structurally compatible with the SDK's `BetaManagedAgentsCustomToolInputSchema`,
 * which wants a mutable `required` and an open index signature.
 */
export interface ToolInputSchema {
  type: "object";
  properties: Record<string, unknown>;
  required: string[];
  [k: string]: unknown;
}

/** Tool descriptions, shared by the hosted agent and the local engine. */
export const GET_HISTORY_DESCRIPTION =
  "Returns a ranked digest of the user's most-visited domains over a recent " +
  "window: visit counts, unique page counts, last-visit timestamps, relevance " +
  "scores, and a few sample page titles per domain. Call this first, once.";

export const GET_PAGE_HTML_DESCRIPTION =
  "Loads URLs in the user's real, logged-in browser, sanitizes the HTML, and " +
  "mounts each page into your sandbox. Returns a mountPath and byte count per " +
  "page plus a list of failures. Use grep/read on the returned mountPath. " +
  "Prefer this over any web fetch: it sees authenticated, JavaScript-rendered " +
  "pages that an anonymous fetch cannot.";

export const GET_HISTORY_SCHEMA: ToolInputSchema = {
  type: "object",
  properties: {
    daysToAnalyze: {
      type: "integer",
      minimum: 1,
      maximum: 90,
      description: "How many days of history to analyze. Default 14.",
    },
    maxResults: {
      type: "integer",
      minimum: 1,
      maximum: 50,
      description: "Top N domains by relevance score. Default 30.",
    },
  },
  required: [],
};

export const GET_PAGE_HTML_SCHEMA: ToolInputSchema = {
  type: "object",
  properties: {
    urls: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: { type: "string" },
      description:
        "URLs to load in real browser tabs. Authenticated, JS-rendered pages work — " +
        "this is the user's own logged-in browser, not a fetch from a datacenter.",
    },
    loadDelayMs: {
      type: "integer",
      minimum: 0,
      maximum: 30000,
      description: "Extra wait after load, for lazy-rendered content. Default 8000.",
    },
  },
  required: ["urls"],
};

export const DEFAULTS = {
  daysToAnalyze: 14,
  maxResults: 30,
  loadDelayMs: 8000,
  /** Cap on titles carried per domain in the digest. */
  sampleTitles: 5,
} as const;
