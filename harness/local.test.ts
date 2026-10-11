import { afterEach, describe, expect, test } from "bun:test";
import { listLocalModels, normalizeBaseUrl } from "../packages/agent-core/local";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function mockFetch(impl: (url: string) => Promise<Response>) {
  globalThis.fetch = ((input: string | URL | Request) => impl(String(input))) as typeof fetch;
}

describe("normalizeBaseUrl", () => {
  test("trims whitespace and trailing slashes", () => {
    expect(normalizeBaseUrl("  http://localhost:11434/v1//  ")).toBe("http://localhost:11434/v1");
  });
});

describe("listLocalModels", () => {
  test("returns sorted model ids from an OpenAI-style list", async () => {
    let requested = "";
    mockFetch(async (url) => {
      requested = url;
      return Response.json({ object: "list", data: [{ id: "qwen3:32b" }, { id: "llama3.3:70b" }, { nope: 1 }] });
    });
    expect(await listLocalModels("http://localhost:11434/v1/")).toEqual(["llama3.3:70b", "qwen3:32b"]);
    expect(requested).toBe("http://localhost:11434/v1/models");
  });

  test("explains an unreachable server", async () => {
    mockFetch(async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(listLocalModels("http://localhost:1234/v1")).rejects.toThrow(
      "Couldn't reach http://localhost:1234/v1/models. Is the server running?",
    );
  });

  test("reports a non-OK status", async () => {
    mockFetch(async () => new Response("forbidden", { status: 403, statusText: "Forbidden" }));
    await expect(listLocalModels("http://localhost:11434/v1")).rejects.toThrow("answered 403 Forbidden");
  });

  test("rejects a response that isn't a model list", async () => {
    mockFetch(async () => Response.json({ models: [] }));
    await expect(listLocalModels("http://localhost:11434")).rejects.toThrow("OpenAI-style model list");
  });
});
