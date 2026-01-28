import { afterEach, describe, expect, it, vi } from "vitest";

import { createDelveTool } from "./delve-tool.js";

type MockResponse = {
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
  text?: () => Promise<string>;
};

function requestUrl(input: RequestInfo): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  if ("url" in input && typeof input.url === "string") return input.url;
  return "";
}

function okResponse(payload: unknown): MockResponse {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
  };
}

describe("delve tool", () => {
  const priorFetch = globalThis.fetch;

  afterEach(() => {
    // @ts-expect-error restore
    global.fetch = priorFetch;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("returns null when disabled", () => {
    const tool = createDelveTool({
      config: {
        tools: {
          delve: { enabled: false },
        },
      },
    });
    expect(tool).toBeNull();
  });

  it("requires a token for requests", async () => {
    const mockFetch = vi.fn(() => Promise.resolve(okResponse({ ok: true }) as Response));
    // @ts-expect-error mock fetch
    globalThis.fetch = mockFetch;

    const tool = createDelveTool({
      config: {
        tools: {
          delve: { baseUrl: "http://localhost:8000" },
        },
      },
    });

    const result = await tool?.execute?.("call", {
      action: "delve",
      body: { bonfire_id: "bonfire-1", query: "hello" },
    });

    expect(mockFetch).not.toHaveBeenCalled();
    expect(result?.details).toMatchObject({ ok: false, error: "missing_token" });
  });

  it("posts to stack add endpoint with agent id", async () => {
    const mockFetch = vi.fn((input: RequestInfo) =>
      Promise.resolve(okResponse({ status: "ok" }) as Response),
    );
    // @ts-expect-error mock fetch
    globalThis.fetch = mockFetch;

    const tool = createDelveTool({
      config: {
        tools: {
          delve: { baseUrl: "http://localhost:8000", token: "tok" },
        },
      },
    });

    await tool?.execute?.("call", {
      action: "stack_add",
      agent_id: "agent-1",
      body: { message: { text: "hello" } },
    });

    expect(mockFetch).toHaveBeenCalled();
    const [input, init] = mockFetch.mock.calls[0] ?? [];
    expect(requestUrl(input as RequestInfo)).toBe("http://localhost:8000/agents/agent-1/stack/add");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer tok",
    });
  });

  it("posts to vector search endpoint", async () => {
    const mockFetch = vi.fn((input: RequestInfo) =>
      Promise.resolve(okResponse({ results: [] }) as Response),
    );
    // @ts-expect-error mock fetch
    globalThis.fetch = mockFetch;

    const tool = createDelveTool({
      config: {
        tools: {
          delve: { token: "tok" },
        },
      },
    });

    await tool?.execute?.("call", {
      action: "vector_search",
      body: { bonfire_ref: "bonfire-1", search_string: "query" },
    });

    expect(mockFetch).toHaveBeenCalled();
    const [input] = mockFetch.mock.calls[0] ?? [];
    expect(requestUrl(input as RequestInfo)).toBe("http://localhost:8000/vector_store/search");
  });
});
