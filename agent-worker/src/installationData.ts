import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Config } from "./config.js";

/**
 * Live-installation-data channel for the triage and implement sessions.
 *
 * A support case is reported from a specific customer Hub, and the root cause
 * is often only visible in that Hub's **actual** energy data — the same data a
 * human maintainer would pull from `borzoi-backend`'s AI Query Service with
 * `.claude/ai-token.txt` (see `borzoi-backend/docs/AI_QUERY_SERVICE.md`).
 *
 * We expose two read-only MCP tools, bound to the case's GitHub issue number:
 *   - `get_installation_catalog` — the self-describing catalog (what metrics,
 *     settings, devices, and live predictions exist + how to query them).
 *   - `query_installation_data` — fetch the specific metrics/settings/breakdowns
 *     the session asks for, over a time window.
 *
 * Both proxy through central (`voltini.energy-backend`), which resolves the
 * case → installation → Hub and mints the system token — the worker only ever
 * talks to central, exactly as it does for the case journal. Querying is
 * read-only and pushes no customer notification, so unlike the case-status
 * mutations there is no customer-facing gate.
 *
 * Failure is returned as a descriptive text result, never thrown: a Hub in a
 * customer home is frequently offline, and a backfilled case may have no linked
 * installation. The session must degrade to reasoning without live data rather
 * than aborting the case.
 */

export interface InstallationDataHandle {
  serverName: string;
  server: ReturnType<typeof createSdkMcpServer>;
  /** Fully-qualified tool names, for allowedTools if ever needed. */
  toolNames: string[];
}

/** A device-sensor selector for raw readings (mirrors IAiQueryRequest.deviceMetrics). */
const DeviceMetricSchema = z.object({
  deviceId: z.string().describe("Device id from the catalog's device sensors."),
  capability: z.string().describe("Sensor capability to read (from the catalog)."),
});

/** Query args — mirrors borzoi-common `IAiQueryRequest` (from + to are required). */
const QueryArgsSchema = {
  from: z.string().describe("Period start, ISO 8601 (e.g. 2026-03-07T00:00:00Z). Required."),
  to: z.string().describe("Period end, ISO 8601. Required."),
  resolution: z
    .number()
    .optional()
    .describe("Bucket size in minutes. Auto-selected if omitted (<=2h→1, <=24h→5, <=7d→15, else 60)."),
  computedMetrics: z
    .array(z.string())
    .optional()
    .describe("Computed metric names from the catalog (e.g. consumptionactual, spotpriceimport)."),
  weatherMetrics: z.array(z.string()).optional().describe("Weather metric names from the catalog."),
  deviceMetrics: z
    .array(DeviceMetricSchema)
    .optional()
    .describe("Raw device sensor readings to fetch."),
  powerBreakdown: z.boolean().optional().describe("Power consumption grouped by category."),
  deviceBreakdown: z.boolean().optional().describe("Per-device breakdown within power categories."),
  settings: z.array(z.string()).optional().describe("Setting keys to include (from the catalog)."),
  topPeaks: z.boolean().optional().describe("This month's top hourly peaks."),
  livePredictions: z
    .array(z.string())
    .optional()
    .describe("Live (forward-looking) prediction names from the catalog."),
  lpContext: z.boolean().optional().describe("Latest LP optimization context snapshot."),
  summaryOnly: z
    .boolean()
    .optional()
    .describe("Return only per-metric summary stats (min/max/avg/count), no raw points. Use for wide windows."),
};

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

/**
 * Call a central agent endpoint and return its JSON as a text tool result.
 * `path` is appended to `{base}/api/support/agent/cases/{issueNumber}`. Any
 * non-2xx (including the central 422 "no linked installation" and an offline
 * Hub surfaced as 500) and any network error are converted to a clear text
 * result so the session keeps going without live data.
 */
export async function callCentral(
  config: Config,
  issueNumber: number,
  path: string,
  init: { method: "GET" | "POST"; body?: unknown },
) {
  const base = config.centralApiBaseUrl.replace(/\/+$/, "");
  const url = `${base}/api/support/agent/cases/${issueNumber}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${config.agentWorkerToken}`,
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  } catch (e) {
    return textResult(
      `Could not reach the installation data service: ${(e as Error).message}. ` +
        "Proceed using the issue details and code; live data is unavailable.",
    );
  }

  const raw = await res.text().catch(() => "");
  if (!res.ok) {
    // Central returns an IStatus { code, message } body on failure (case has no
    // installation, Hub offline, mint failure, …). Surface its message.
    let message = raw;
    try {
      const parsed = JSON.parse(raw) as { message?: string };
      if (parsed?.message) message = parsed.message;
    } catch {
      // keep raw text
    }
    return textResult(
      `Installation data unavailable (HTTP ${res.status}): ${message || "no detail"}. ` +
        "Proceed without live data — do not block the case on this.",
    );
  }
  return textResult(raw);
}

/**
 * Build the `installation-data` MCP server for one case. The two tools are
 * closed over `issueNumber`, so the session never has to (and cannot) target a
 * different installation than the one that reported the case.
 */
export function createInstallationData(
  config: Config,
  issueNumber: number,
): InstallationDataHandle {
  const serverName = "installation-data";

  const catalogTool = tool(
    "get_installation_catalog",
    "Fetch the reporting installation's live-data catalog: which computed/weather metrics, " +
      "device sensors, settings, and live predictions exist, plus tips for investigating " +
      "common issues. Read this BEFORE query_installation_data so you know the exact metric " +
      "and setting names to request. Read-only.",
    {},
    async () => callCentral(config, issueNumber, "/ai-catalog", { method: "GET" }),
  );

  const queryTool = tool(
    "query_installation_data",
    "Query the reporting installation's live energy data (historical metrics, weather, device " +
      "readings, power breakdown, settings, top peaks, live predictions) for a time window. Use " +
      "the names from get_installation_catalog. Keep the window narrow and prefer summaryOnly for " +
      "wide ranges — each metric already includes min/max/avg/count summaries. Read-only.",
    QueryArgsSchema,
    async (args) =>
      callCentral(config, issueNumber, "/ai-query", { method: "POST", body: args }),
  );

  const server = createSdkMcpServer({
    name: serverName,
    version: "1.0.0",
    tools: [catalogTool, queryTool],
  });

  return {
    serverName,
    server,
    toolNames: [
      `mcp__${serverName}__get_installation_catalog`,
      `mcp__${serverName}__query_installation_data`,
    ],
  };
}
