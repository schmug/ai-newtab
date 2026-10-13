import { describe, expect, test } from "bun:test";
import {
  OUTPUT_PATH,
  globFiles,
  grepFiles,
  readFile,
  runLocalHomepageBuild,
  splitHtmlLines,
  type BrowserBridge,
} from "@homepage/agent-core";
import { fixtureHistory } from "./node-bridge";

type Turn = { content?: string; calls?: { name: string; args?: unknown; raw?: string }[]; json?: boolean };

/**
 * A scripted OpenAI-compatible server. Each request pops the next turn and
 * streams it back as SSE, splitting tool arguments across chunks the way real
 * servers do. Requests are recorded so tests can inspect what the model was sent.
 */
function fakeServer(turns: Turn[]) {
  const requests: any[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    expect(url).toBe("http://localhost:11434/v1/chat/completions");
    requests.push(JSON.parse(String(init.body)));
    const turn = turns.shift();
    if (!turn) throw new Error("model called more times than scripted");
    const toolCalls = (turn.calls ?? []).map((c, i) => ({
      id: `call_${requests.length}_${i}`,
      type: "function",
      function: { name: c.name, arguments: c.raw ?? JSON.stringify(c.args) },
    }));
    if (turn.json) {
      return Response.json({ choices: [{ message: { content: turn.content ?? null, tool_calls: toolCalls } }] });
    }
    const chunks: unknown[] = [];
    if (turn.content) {
      for (const piece of turn.content.match(/.{1,12}/gs) ?? []) chunks.push({ choices: [{ delta: { content: piece } }] });
    }
    toolCalls.forEach((call, index) => {
      const args = call.function.arguments;
      const half = Math.ceil(args.length / 2);
      chunks.push({ choices: [{ delta: { tool_calls: [{ index, id: call.id, function: { name: call.function.name, arguments: args.slice(0, half) } }] } }] });
      chunks.push({ choices: [{ delta: { tool_calls: [{ index, function: { arguments: args.slice(half) } }] } }] });
    });
    const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;
  return { fetchImpl, requests };
}

const PAGE_HTML =
  "<div><h2>Top Story: Local models ship</h2><p><a href=\"https://news.example.com/a\">Read</a></p></div><div><h2>Second Story</h2></div>";

function bridge(calls: string[][]): BrowserBridge {
  return {
    getHistory: async () => ({ sites: fixtureHistory(), totalSitesSeen: fixtureHistory().length }),
    getPageHtml: async ({ urls }) => {
      calls.push(urls);
      return { pages: urls.map((url) => ({ url, title: "News", html: PAGE_HTML })), failed: [] };
    },
  };
}

const COMPONENT = "import React from 'react';\nexport default function PersonalizedHomepage() { return <main>Top Story</main>; }";

describe("runLocalHomepageBuild", () => {
  test("runs the tool loop end to end and returns the written component", async () => {
    const scrapes: string[][] = [];
    const { fetchImpl, requests } = fakeServer([
      { content: "Looking at your history.", calls: [{ name: "getHistory", args: { maxResults: 5 } }] },
      { calls: [{ name: "getPageHtml", args: { urls: ["https://news.example.com/", "https://mail.blocked.test/"] } }] },
      { calls: [{ name: "grep", args: { pattern: "Story", ignoreCase: true } }] },
      // Only the file name: small models often drop the directory.
      { calls: [{ name: "read", args: { path: "news_example_com_0.html" } }] },
      { content: "I have what I need." }, // stops without writing: gets a reminder
      { calls: [{ name: "write", args: { path: OUTPUT_PATH, content: COMPONENT } }] },
      { content: "Built a news-first homepage.", json: true },
    ]);
    const logs: string[] = [];

    const result = await runLocalHomepageBuild({
      baseUrl: "http://localhost:11434/v1/",
      model: "qwen3:32b",
      bridge: bridge(scrapes),
      blockedSites: ["blocked.test"],
      fetch: fetchImpl,
      callbacks: { onLog: (l) => logs.push(l) },
    });

    expect(result).toEqual({ code: COMPONENT, sessionId: "local", source: "session-output" });
    expect(requests).toHaveLength(7);
    expect(requests[0].model).toBe("qwen3:32b");
    expect(requests[0].tools.map((t: any) => t.function.name)).toEqual(["getHistory", "getPageHtml", "read", "grep", "glob", "write"]);

    // The blocked host never reached the browser, and the model was told why.
    expect(scrapes).toEqual([["https://news.example.com/"]]);
    const toolResults = requests[6].messages.filter((m: any) => m.role === "tool").map((m: any) => m.content);
    const pages = JSON.parse(toolResults[1]);
    expect(pages.pages[0].mountPath).toBe("/mnt/session/uploads/pages/news_example_com_0.html");
    expect(pages.failed).toEqual([{ url: "https://mail.blocked.test/", reason: "blocked by the user's settings" }]);

    // grep and read worked over the in-memory page, split into lines.
    expect(toolResults[2]).toContain("news_example_com_0.html:1: <div><h2>Top Story");
    expect(toolResults[2]).toContain(":4: <div><h2>Second Story");
    expect(toolResults[3]).toContain("1\t<div><h2>Top Story");

    // The reminder went in as a user turn after the model stopped early.
    expect(requests[5].messages.at(-1)).toEqual({
      role: "user",
      content: expect.stringContaining(`You have not written ${OUTPUT_PATH} yet`),
    });
    // Every assistant tool call was answered before the next request.
    for (const req of requests) {
      const asked = req.messages.flatMap((m: any) => m.tool_calls ?? []).map((c: any) => c.id);
      const answered = req.messages.filter((m: any) => m.role === "tool").map((m: any) => m.tool_call_id);
      expect(answered).toEqual(asked);
    }
  });

  test("hands bad tool arguments back to the model instead of failing", async () => {
    const { fetchImpl, requests } = fakeServer([
      { calls: [{ name: "read", raw: '{"path": "x.html"' }] },
      { calls: [{ name: "nope", args: {} }] },
      { calls: [{ name: "write", args: { path: "/tmp/x.tsx", content: COMPONENT } }] },
      { content: "Done." },
    ]);
    const result = await runLocalHomepageBuild({
      baseUrl: "http://localhost:11434/v1",
      model: "m",
      bridge: bridge([]),
      fetch: fetchImpl,
    });
    expect(result.code).toBe(COMPONENT);
    const tools = requests[2].messages.filter((m: any) => m.role === "tool").map((m: any) => m.content);
    expect(tools[0]).toContain("were not valid JSON");
    expect(tools[1]).toContain("Unknown tool: nope");
  });

  test("falls back to a fenced component, then fails clearly when there is none", async () => {
    const fenced = fakeServer([{ content: "Here:\n```tsx\n" + COMPONENT + "\n```" }]);
    const result = await runLocalHomepageBuild({ baseUrl: "http://localhost:11434/v1", model: "m", bridge: bridge([]), fetch: fenced.fetchImpl });
    expect(result.source).toBe("message-fence");
    expect(result.code).toBe(COMPONENT);

    const empty = fakeServer([{ content: "no" }, { content: "still no" }, { content: "never" }]);
    await expect(
      runLocalHomepageBuild({ baseUrl: "http://localhost:11434/v1", model: "m", bridge: bridge([]), fetch: empty.fetchImpl }),
    ).rejects.toThrow("The local model produced no homepage");
    expect(empty.requests).toHaveLength(3); // the first try plus two reminders
  });

  test("reports server errors and an unreachable server readably", async () => {
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(
      runLocalHomepageBuild({ baseUrl: "http://localhost:11434/v1", model: "m", bridge: bridge([]), fetch: down }),
    ).rejects.toThrow("Couldn't reach the local model at http://localhost:11434/v1/chat/completions");

    const missing = (async () => new Response('{"error":"model \\"m\\" not found"}', { status: 404 })) as unknown as typeof fetch;
    await expect(
      runLocalHomepageBuild({ baseUrl: "http://localhost:11434/v1", model: "m", bridge: bridge([]), fetch: missing }),
    ).rejects.toThrow('Local model server answered 404: {"error":"model \\"m\\" not found"}');
  });
});

describe("in-memory file tools", () => {
  const files = new Map([
    ["/mnt/session/uploads/pages/a_0.html", "one\ntwo match\nthree"],
    ["/mnt/session/uploads/pages/b_1.html", "Match here"],
  ]);

  test("splitHtmlLines breaks after block tags", () => {
    expect(splitHtmlLines("<p>a</p>  <div>b</div><br><li>c</li>")).toBe("<p>a</p>\n<div>b</div>\n<br>\n<li>c</li>");
  });

  test("read pages through a file and points at the next offset", () => {
    expect(readFile(files, { path: "/mnt/session/uploads/pages/a_0.html", offset: 2, limit: 1 })).toBe(
      "/mnt/session/uploads/pages/a_0.html\n2\ttwo match\n[lines 2-2 of 3; read again with offset 3 for more]",
    );
    expect(() => readFile(files, { path: "/nope.html" })).toThrow("No file at /nope.html");
  });

  test("grep honors case, scope, and treats a broken regex literally", () => {
    expect(grepFiles(files, { pattern: "match" })).toBe("/mnt/session/uploads/pages/a_0.html:2: two match");
    expect(grepFiles(files, { pattern: "match", ignoreCase: true }).split("\n")).toHaveLength(2);
    expect(grepFiles(files, { pattern: "Match", path: "/mnt/session/uploads/pages/b_1.html" })).toContain("b_1.html:1");
    expect(grepFiles(files, { pattern: "(" })).toBe("No matches.");
  });

  test("glob matches * within a directory and ** across them", () => {
    expect(globFiles(files, { pattern: "/mnt/session/uploads/pages/*.html" })).toContain("a_0.html (19b)");
    expect(globFiles(files, { pattern: "/mnt/**/b_*.html" })).toBe("/mnt/session/uploads/pages/b_1.html (10b)");
    expect(globFiles(files, { pattern: "/other/*" })).toBe("No files match.");
  });
});
