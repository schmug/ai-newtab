/**
 * The local engine: the same homepage agent, run entirely on this machine.
 *
 * The hosted path (orchestrator.ts) leans on Anthropic for three things: the
 * agent loop, a sandbox holding the scraped pages, and the read/grep/glob/write
 * tools over it. Here the host supplies all three. The loop talks to any
 * OpenAI-compatible `/chat/completions` server (Ollama, LM Studio, llama.cpp,
 * vLLM), the pages live in an in-memory file map, and the tools run over that
 * map. Nothing leaves the machine except the page loads the browser makes anyway.
 *
 * There is no session to reattach to: if the host dies mid-build the build is
 * lost, and the next manual or scheduled build starts over.
 */
import { slugifyUrl } from "./history-digest";
import { localHeaders, normalizeBaseUrl } from "./local";
import {
  CODE_FENCE,
  runGetHistory,
  scrapeAllowedPages,
  stripFence,
  type Emit,
  type GetHistoryInput,
  type GetPageHtmlInput,
} from "./orchestrator";
import { HOMEPAGE_SYSTEM_PROMPT, OUTPUT_PATH, buildKickoffMessage } from "./prompt";
import {
  GET_HISTORY_DESCRIPTION,
  GET_HISTORY_SCHEMA,
  GET_PAGE_HTML_DESCRIPTION,
  GET_PAGE_HTML_SCHEMA,
} from "./schemas";
import { DEFAULT_BLOCKED_SITES, normalizeBlockList } from "./site-filter";
import type { BrowserBridge, GetPageHtmlResult, HomepageBuildResult, PageRef, RunCallbacks } from "./types";

/** Same place the hosted sandbox mounts pages, so the shared system prompt reads true. */
const PAGES_ROOT = "/mnt/session/uploads/pages";

/** Model calls per build. A normal build takes 10–25; this only stops a model stuck in a loop. */
const MAX_STEPS = 60;
/** Times the model is reminded to write the file before the build gives up on it. */
const MAX_NUDGES = 2;
/** `read` returns at most this many lines, and at most this many characters. */
const READ_MAX_LINES = 200;
/** Small enough that a 9K-token window holds a read plus the prompt; HTML runs ~3 chars a token. */
const READ_MAX_CHARS = 8_000;
/** `grep` returns at most this many matches, each line cut to this length. */
const GREP_MAX_MATCHES = 60;
const GREP_LINE_CHARS = 300;

/** Context window assumed when the server doesn't report one (Ollama, LM Studio). */
const DEFAULT_CONTEXT_TOKENS = 32_768;
/** Held back from the window for the reply; the component itself runs a few thousand tokens. */
const MAX_REPLY_RESERVE = 8_192;
/** Rough chars per token. Low on purpose: HTML tokenizes densely, and overshooting the window fails the build. */
const CHARS_PER_TOKEN = 3;
/** History domains per call. The hosted default (30) costs several thousand tokens that never get trimmed. */
const HISTORY_MAX_RESULTS = 15;
/** Tools whose output can be fetched again, so it is what gets trimmed when the window is full. */
const REFETCHABLE = new Set(["read", "grep", "glob"]);

/** Appended to the shared prompt: what differs when the tools are local. */
const LOCAL_ADDENDUM = `

## Tool notes for this run

- read takes { path, offset?, limit? }. It returns numbered lines, at most ${READ_MAX_LINES}
  lines or ${READ_MAX_CHARS} characters per call. Page further with offset.
- grep takes { pattern, path?, ignoreCase? }. pattern is a JavaScript regular
  expression; path narrows the search to one file or a directory. It returns at most
  ${GREP_MAX_MATCHES} matches as "path:line: text".
- glob takes { pattern }, e.g. "${PAGES_ROOT}/*.html".
- write takes { path, content }. Write the whole component in one call.
- Tool arguments must be valid JSON.`;

export interface LocalRunOptions {
  /** OpenAI-compatible base URL, e.g. http://localhost:11434/v1. */
  baseUrl: string;
  /** Model name as the server knows it. */
  model: string;
  /** Sent as a bearer token when set; most local servers need none. */
  apiKey?: string | null;
  /** The model's context window. Default: what the server's /models reports, else 32K. */
  contextTokens?: number;
  bridge: BrowserBridge;
  userSystemPrompt?: string;
  /** Re-read before every tool call, as in the hosted engine. */
  blockedSites?: string[] | (() => Promise<string[]>);
  callbacks?: RunCallbacks;
  signal?: AbortSignal;
  now?: Date;
  /** Injected for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
}

// ---------------------------------------------------------------------------
// OpenAI chat-completions wire types (just the parts used here)
// ---------------------------------------------------------------------------

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

const fn = (name: string, description: string, parameters: object) => ({
  type: "function" as const,
  function: { name, description, parameters },
});

const TOOLS = [
  fn("getHistory", GET_HISTORY_DESCRIPTION, GET_HISTORY_SCHEMA),
  fn("getPageHtml", GET_PAGE_HTML_DESCRIPTION, GET_PAGE_HTML_SCHEMA),
  fn("read", "Read a file you were given a path for. Returns numbered lines.", {
    type: "object",
    properties: {
      path: { type: "string" },
      offset: { type: "integer", minimum: 1, description: "First line to return (1-based). Default 1." },
      limit: { type: "integer", minimum: 1, maximum: READ_MAX_LINES, description: `Lines to return. Default ${READ_MAX_LINES}.` },
    },
    required: ["path"],
  }),
  fn("grep", "Search files for a regular expression. Returns path:line: text for each match.", {
    type: "object",
    properties: {
      pattern: { type: "string" },
      path: { type: "string", description: "A file or directory to search. Default: every file." },
      ignoreCase: { type: "boolean" },
    },
    required: ["pattern"],
  }),
  fn("glob", "List files whose path matches a glob pattern (* and **).", {
    type: "object",
    properties: { pattern: { type: "string" } },
    required: ["pattern"],
  }),
  fn("write", "Write a file. Use it to deliver the finished homepage.", {
    type: "object",
    properties: { path: { type: "string" }, content: { type: "string" } },
    required: ["path", "content"],
  }),
];

// ---------------------------------------------------------------------------
// the loop
// ---------------------------------------------------------------------------

export async function runLocalHomepageBuild(opts: LocalRunOptions): Promise<HomepageBuildResult> {
  const { bridge, callbacks, signal } = opts;
  const emit: Emit = {
    phase: (p, d) => callbacks?.onPhase?.(p, d),
    text: (t) => callbacks?.onText?.(t),
    log: (l) => callbacks?.onLog?.(l),
  };
  const files = new Map<string, string>();

  emit.phase("setup");
  emit.log(`local model ${opts.model} at ${normalizeBaseUrl(opts.baseUrl)}`);
  const contextTokens = opts.contextTokens ?? (await reportedContext(opts, signal)) ?? DEFAULT_CONTEXT_TOKENS;
  const promptBudget = contextTokens - Math.min(MAX_REPLY_RESERVE, Math.floor(contextTokens * 0.4));
  emit.log(`context window ${contextTokens} tokens`);

  const messages: ChatMessage[] = [
    { role: "system", content: HOMEPAGE_SYSTEM_PROMPT + LOCAL_ADDENDUM },
    {
      role: "user",
      content: buildKickoffMessage({ now: opts.now ?? new Date(), userSystemPrompt: opts.userSystemPrompt }),
    },
  ];

  const blockedSites = async () =>
    normalizeBlockList(
      (typeof opts.blockedSites === "function" ? await opts.blockedSites() : opts.blockedSites) ?? DEFAULT_BLOCKED_SITES,
    );

  const tools: Record<string, (args: any) => Promise<unknown>> = {
    getHistory: async (args: GetHistoryInput) =>
      runGetHistory(
        { ...args, maxResults: Math.min(args.maxResults ?? HISTORY_MAX_RESULTS, HISTORY_MAX_RESULTS) },
        bridge,
        emit,
        await blockedSites(),
      ),
    getPageHtml: async (args: GetPageHtmlInput) => mountPages(args, bridge, emit, await blockedSites(), files),
    read: async (args) => readFile(files, args),
    grep: async (args) => grepFiles(files, args),
    glob: async (args) => globFiles(files, args),
    write: async (args: { path?: unknown; content?: unknown }) => {
      if (typeof args.path !== "string" || typeof args.content !== "string") {
        throw new Error("write needs a string path and string content");
      }
      files.set(args.path, args.content);
      emit.phase("writing");
      emit.log(`wrote ${args.path} (${args.content.length}b)`);
      return { ok: true, path: args.path, bytes: args.content.length };
    },
  };

  let finalMessage = "";
  let nudges = 0;

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      if (signal?.aborted) throw new Error("aborted");
      emit.phase("thinking");

      const trimmed = compactMessages(messages, promptBudget);
      if (trimmed) emit.log(`trimmed ${trimmed} earlier tool result(s) to fit the context window`);

      const reply = await chatCompletion(opts, messages, emit, signal);
      messages.push({
        role: "assistant",
        content: reply.content || null,
        ...(reply.toolCalls.length ? { tool_calls: reply.toolCalls } : {}),
      });
      if (reply.content) finalMessage = reply.content;

      if (reply.toolCalls.length === 0) {
        if (deliverable(files) || fencedComponent(reply.content)) break;
        if (nudges >= MAX_NUDGES) break;
        nudges++;
        emit.log("model stopped without writing the homepage; reminding it");
        messages.push({
          role: "user",
          content: `You have not written ${OUTPUT_PATH} yet. Call the write tool with the complete PersonalizedHomepage component now.`,
        });
        continue;
      }

      // Every tool call gets an answer, errors included, or the next request is malformed.
      for (const call of reply.toolCalls) {
        const content = await runTool(tools, call, emit);
        messages.push({ role: "tool", tool_call_id: call.id, content });
      }
    }

    const written = deliverable(files);
    if (written) {
      emit.phase("done");
      return { code: stripFence(written), sessionId: "local", source: "session-output" };
    }

    // Same fallback as the hosted engine: the component pasted inline.
    const fenced = fencedComponent(finalMessage);
    if (fenced) {
      emit.log("deliverable recovered from message fence");
      emit.phase("done");
      return { code: fenced, sessionId: "local", source: "message-fence" };
    }

    throw new Error(
      `The local model produced no homepage. Expected a file at ${OUTPUT_PATH}. ` +
        `Final message: ${finalMessage.slice(0, 400)}`,
    );
  } finally {
    // Pages only ever lived in memory; drop them with the build.
    emit.phase("cleanup");
    files.clear();
  }
}

/**
 * Keeps the conversation under `budgetTokens` (estimated) by replacing the
 * oldest read/grep/glob results with a note, in place. The system prompt, the
 * kickoff, history and page lists, and the latest round of tool results are
 * never touched. Returns how many results were replaced; the conversation can
 * still be over budget if nothing else is trimmable.
 */
export function compactMessages(messages: ChatMessage[], budgetTokens: number): number {
  const estimate = () => messages.reduce((n, m) => n + JSON.stringify(m).length, 0) / CHARS_PER_TOKEN;
  if (estimate() <= budgetTokens) return 0;

  const calls = new Map<string, ToolCall>();
  let lastAssistant = -1;
  messages.forEach((m, i) => {
    if (m.role !== "assistant") return;
    lastAssistant = i;
    for (const c of m.tool_calls ?? []) calls.set(c.id, c);
  });

  let trimmed = 0;
  for (let i = 0; i < lastAssistant && estimate() > budgetTokens; i++) {
    const m = messages[i];
    if (m.role !== "tool") continue;
    const call = calls.get(m.tool_call_id);
    if (!call || !REFETCHABLE.has(call.function.name) || m.content.startsWith("[Output removed")) continue;
    messages[i] = {
      ...m,
      content: `[Output removed to fit the context window: ${call.function.name} ${call.function.arguments.slice(0, 200)}. Call it again if you still need it.]`,
    };
    trimmed++;
  }
  return trimmed;
}

/** The model's context window from `/models`, as Unsloth Studio and llama.cpp report it; undefined if not given. */
async function reportedContext(opts: LocalRunOptions, signal?: AbortSignal): Promise<number | undefined> {
  try {
    const response = await (opts.fetch ?? fetch)(`${normalizeBaseUrl(opts.baseUrl)}/models`, {
      headers: localHeaders(opts.apiKey),
      signal,
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as { data?: { id?: unknown; context_length?: unknown }[] };
    const size = body.data?.find((m) => m.id === opts.model)?.context_length;
    return typeof size === "number" && size > 0 ? size : undefined;
  } catch {
    return undefined;
  }
}

/** The homepage, if written: the expected path first, else any component file. */
function deliverable(files: Map<string, string>): string | undefined {
  const exact = files.get(OUTPUT_PATH);
  if (exact?.trim()) return exact;
  for (const [path, content] of files) {
    if (/\.(tsx|jsx)$/.test(path) && content.trim()) return content;
  }
  return undefined;
}

/** A component pasted inline in a ```tsx fence, when the model skipped the write tool. */
function fencedComponent(text: string): string | undefined {
  const fenced = text.match(CODE_FENCE);
  return fenced && fenced[1].includes("PersonalizedHomepage") ? fenced[1].trim() : undefined;
}

async function runTool(
  tools: Record<string, (args: any) => Promise<unknown>>,
  call: ToolCall,
  emit: Emit,
): Promise<string> {
  const name = call.function.name;
  const handler = tools[name];
  if (!handler) return JSON.stringify({ error: `Unknown tool: ${name}` });
  if (name !== "getHistory" && name !== "getPageHtml") {
    emit.phase("analyzing", name);
    emit.log(`local:${name}`);
  }
  let args: unknown;
  try {
    args = call.function.arguments.trim() ? JSON.parse(call.function.arguments) : {};
  } catch {
    return JSON.stringify({ error: `Arguments for ${name} were not valid JSON: ${call.function.arguments.slice(0, 200)}` });
  }
  try {
    const result = await handler(args ?? {});
    return typeof result === "string" ? result : JSON.stringify(result);
  } catch (err) {
    emit.log(`tool ${name} failed: ${String(err)}`);
    return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
  }
}

// ---------------------------------------------------------------------------
// talking to the server
// ---------------------------------------------------------------------------

/**
 * One streamed chat completion. Streaming keeps bytes flowing during a long
 * generation (a 70B model writing a whole component can take minutes), which
 * keeps the extension's service worker busy, and feeds the progress panel.
 */
async function chatCompletion(
  opts: LocalRunOptions,
  messages: ChatMessage[],
  emit: Emit,
  signal?: AbortSignal,
): Promise<{ content: string; toolCalls: ToolCall[] }> {
  const doFetch = opts.fetch ?? fetch;
  const url = `${normalizeBaseUrl(opts.baseUrl)}/chat/completions`;
  let response: Response;
  try {
    response = await doFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...localHeaders(opts.apiKey) },
      body: JSON.stringify({ model: opts.model, messages, tools: TOOLS, tool_choice: "auto", stream: true }),
      signal,
    });
  } catch (err) {
    if (signal?.aborted) throw new Error("aborted");
    throw new Error(`Couldn't reach the local model at ${url}. Is the server running? (${String(err)})`);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Local model server answered ${response.status}: ${body.slice(0, 300)}`);
  }

  // A server that ignores `stream: true` answers with one JSON body.
  if (!(response.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const body = (await response.json()) as {
      choices?: { message?: { content?: string | null; tool_calls?: ToolCall[] } }[];
    };
    const message = body.choices?.[0]?.message;
    const content = message?.content ?? "";
    if (content) emit.text(content);
    return { content, toolCalls: (message?.tool_calls ?? []).map(normalizeToolCall) };
  }

  let content = "";
  const calls: { id?: string; name: string; arguments: string }[] = [];
  for await (const chunk of sseEvents(response.body!)) {
    const delta = chunk.choices?.[0]?.delta;
    if (!delta) continue;
    if (delta.reasoning_content || delta.reasoning) emit.phase("thinking");
    if (delta.content) {
      content += delta.content;
      emit.text(delta.content);
    }
    for (const part of delta.tool_calls ?? []) {
      const i = part.index ?? calls.length;
      calls[i] ??= { name: "", arguments: "" };
      if (part.id) calls[i].id = part.id;
      if (part.function?.name) calls[i].name += part.function.name;
      if (part.function?.arguments) calls[i].arguments += part.function.arguments;
    }
  }

  const toolCalls = calls.filter(Boolean).map((c, i) =>
    normalizeToolCall({ id: c.id ?? "", type: "function", function: { name: c.name, arguments: c.arguments } }, i),
  );
  return { content, toolCalls };
}

/** Some servers omit ids or send arguments as an object; make every call well-formed. */
function normalizeToolCall(call: ToolCall, index: number): ToolCall {
  const args = call.function?.arguments as unknown;
  return {
    id: call.id || `call_${index}_${Math.random().toString(36).slice(2, 8)}`,
    type: "function",
    function: {
      name: call.function?.name ?? "",
      arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}),
    },
  };
}

interface StreamChunk {
  choices?: {
    delta?: {
      content?: string | null;
      reasoning?: string;
      reasoning_content?: string;
      tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[];
    };
  }[];
}

async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return;
      try {
        yield JSON.parse(data) as StreamChunk;
      } catch {
        // A keepalive or partial line; skip it.
      }
    }
  }
}

// ---------------------------------------------------------------------------
// in-memory pages and the tools over them
// ---------------------------------------------------------------------------

/**
 * Sanitized HTML often arrives as a handful of enormous lines, which defeats
 * line-based grep and read. Break after block-level tags so a "line" is roughly
 * one paragraph, list item or heading.
 */
export function splitHtmlLines(html: string): string {
  return html
    .replace(/(<\/(?:p|div|li|h[1-6]|tr|table|ul|ol|blockquote|pre|figure|figcaption)>|<br\s*\/?>|<hr\s*\/?>)/gi, "$1\n")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

async function mountPages(
  input: GetPageHtmlInput,
  bridge: BrowserBridge,
  emit: Emit,
  blockedSites: string[],
  files: Map<string, string>,
): Promise<GetPageHtmlResult> {
  if (!Array.isArray(input?.urls) || input.urls.length === 0) {
    throw new Error("getPageHtml needs a non-empty urls array");
  }
  const { pages, blocked, failed } = await scrapeAllowedPages(input, bridge, emit, blockedSites);
  const refs: PageRef[] = [];
  for (const page of pages) {
    const html = splitHtmlLines(page.html);
    const mountPath = `${PAGES_ROOT}/${slugifyUrl(page.url)}_${files.size}.html`;
    files.set(mountPath, html);
    refs.push({ url: page.url, title: page.title, mountPath, bytes: html.length });
    emit.log(`loaded ${page.url} -> ${mountPath} (${html.length}b)`);
  }
  return { pages: refs, failed: [...blocked, ...failed] };
}

/** Exact path first; failing that, a unique file with the same name, since small models garble directories. */
function resolvePath(files: Map<string, string>, path: unknown): string {
  if (typeof path !== "string" || !path) throw new Error("path is required");
  if (files.has(path)) return path;
  const name = path.split("/").pop();
  const byName = [...files.keys()].filter((p) => p.split("/").pop() === name);
  if (byName.length === 1) return byName[0];
  throw new Error(`No file at ${path}. Files: ${[...files.keys()].join(", ") || "(none)"}`);
}

export function readFile(files: Map<string, string>, args: { path?: unknown; offset?: unknown; limit?: unknown }): string {
  const path = resolvePath(files, args.path);
  const lines = files.get(path)!.split("\n");
  const offset = Math.max(1, Number(args.offset) || 1);
  const limit = Math.min(READ_MAX_LINES, Math.max(1, Number(args.limit) || READ_MAX_LINES));
  const out: string[] = [];
  let chars = 0;
  let last = offset - 1;
  for (let i = offset - 1; i < Math.min(lines.length, offset - 1 + limit); i++) {
    const line = `${i + 1}\t${lines[i]}`;
    if (chars + line.length > READ_MAX_CHARS && out.length > 0) break;
    out.push(line.length > READ_MAX_CHARS ? line.slice(0, READ_MAX_CHARS) : line);
    chars += line.length;
    last = i + 1;
  }
  const more = last < lines.length ? `\n[lines ${offset}-${last} of ${lines.length}; read again with offset ${last + 1} for more]` : "";
  return `${path}\n${out.join("\n")}${more}`;
}

export function grepFiles(
  files: Map<string, string>,
  args: { pattern?: unknown; path?: unknown; ignoreCase?: unknown },
): string {
  if (typeof args.pattern !== "string" || !args.pattern) throw new Error("pattern is required");
  let re: RegExp;
  try {
    re = new RegExp(args.pattern, args.ignoreCase ? "i" : "");
  } catch {
    // Small models often send plain text with stray regex characters; search for it literally.
    re = new RegExp(args.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), args.ignoreCase ? "i" : "");
  }
  const scope = typeof args.path === "string" && args.path ? args.path : null;
  const targets = scope && files.has(scope)
    ? [scope]
    : [...files.keys()].filter((p) => !scope || p.startsWith(scope.replace(/\/?$/, "/")));

  const matches: string[] = [];
  let total = 0;
  for (const path of targets) {
    const lines = files.get(path)!.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i])) continue;
      total++;
      if (matches.length < GREP_MAX_MATCHES) {
        matches.push(`${path}:${i + 1}: ${lines[i].slice(0, GREP_LINE_CHARS)}`);
      }
    }
  }
  if (total === 0) return "No matches.";
  const more = total > matches.length ? `\n[${total - matches.length} more matches not shown; narrow the pattern or path]` : "";
  return matches.join("\n") + more;
}

export function globFiles(files: Map<string, string>, args: { pattern?: unknown }): string {
  if (typeof args.pattern !== "string" || !args.pattern) throw new Error("pattern is required");
  const source = args.pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\u0000/g, ".*");
  const re = new RegExp(`^${source}$`);
  const hits = [...files.entries()].filter(([p]) => re.test(p)).map(([p, c]) => `${p} (${c.length}b)`);
  return hits.length ? hits.join("\n") : "No files match.";
}
