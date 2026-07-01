import { expect } from "chai";
import { callCentral } from "../installationData.js";
import type { Config } from "../config.js";

/**
 * `callCentral` is the network core behind the two live-data MCP tools. The
 * invariant that matters for the pipeline: it must NEVER throw — an offline
 * Hub, an unlinked case, or a network error all have to come back as a
 * descriptive text result so the agent session degrades to reasoning without
 * live data instead of aborting the case.
 */

const config = {
  centralApiBaseUrl: "https://central.test",
  agentWorkerToken: "tok",
} as Config;

function textOf(result: Awaited<ReturnType<typeof callCentral>>): string {
  return result.content[0]!.text;
}

let originalFetch: typeof fetch;
let lastRequest: { url: string; method: string; auth: string | null; body: string | null };

/** Mock central returning a fixed status + body for whatever is requested. */
function mockCentral(status: number, body: unknown): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    lastRequest = {
      url,
      method: init?.method ?? "GET",
      auth: (init?.headers as Record<string, string> | undefined)?.Authorization ?? null,
      body: (init?.body as string | undefined) ?? null,
    };
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => text,
    } as Response;
  }) as unknown as typeof fetch;
}

before(() => {
  originalFetch = globalThis.fetch;
});
after(() => {
  globalThis.fetch = originalFetch;
});

describe("installationData.callCentral", () => {
  it("returns the raw upstream body verbatim on success", async () => {
    const catalog = { systemDescription: "Voltini", metrics: [] };
    globalThis.fetch = mockCentral(200, catalog);
    const res = await callCentral(config, 42, "/ai-catalog", { method: "GET" });
    expect(textOf(res)).to.equal(JSON.stringify(catalog));
  });

  it("targets the case-scoped central endpoint with the worker token", async () => {
    globalThis.fetch = mockCentral(200, {});
    await callCentral(config, 7, "/ai-query", { method: "POST", body: { from: "a", to: "b" } });
    expect(lastRequest.url).to.equal(
      "https://central.test/api/support/agent/cases/7/ai-query",
    );
    expect(lastRequest.method).to.equal("POST");
    expect(lastRequest.auth).to.equal("Bearer tok");
    expect(lastRequest.body).to.equal(JSON.stringify({ from: "a", to: "b" }));
  });

  it("surfaces the central message (not a throw) when the case has no installation", async () => {
    globalThis.fetch = mockCentral(422, {
      code: -4,
      message: "Case has no linked installation to query",
    });
    const res = await callCentral(config, 1, "/ai-catalog", { method: "GET" });
    expect(textOf(res)).to.contain("Case has no linked installation");
    expect(textOf(res)).to.contain("Proceed without live data");
  });

  it("reports an offline/unreachable Hub as text instead of throwing", async () => {
    globalThis.fetch = mockCentral(500, {
      code: -1,
      message: "Could not reach installation: fetch failed",
    });
    const res = await callCentral(config, 1, "/ai-query", { method: "POST", body: {} });
    expect(textOf(res)).to.contain("Could not reach installation");
  });

  it("does not throw on a network-layer failure", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const res = await callCentral(config, 1, "/ai-catalog", { method: "GET" });
    expect(textOf(res)).to.contain("Could not reach the installation data service");
    expect(textOf(res)).to.contain("ECONNREFUSED");
  });
});
