/**
 * Strict configuration loading.
 *
 * Secrets and operational knobs come ONLY from the environment (.env loaded by
 * docker-compose's env_file). Every required value is validated here and the
 * process throws on a missing one — a misconfigured worker must fail loudly at
 * startup, not quietly do the wrong thing against customer-facing GitHub issues.
 *
 * There is no repo registry. A human pre-clones the repos the bot may work on
 * into REPOS_DIR; any git repo found there is workable. If a case needs a repo
 * that isn't present, the bot asks a human to clone it (see repos.ts).
 */
import { hostname } from "node:os";

export interface Config {
  // Claude backend. The Agent SDK authenticates against a Claude subscription
  // with a long-lived OAuth token (minted once via `claude setup-token`); no
  // per-token API/Bedrock billing. main.ts surfaces the token into the
  // environment the SDK reads at startup.
  oauthToken: string;
  model: string;

  // GitHub
  ghToken: string;
  botLogin: string;
  supportRepo: string;

  // Repos
  reposDir: string;

  // Behaviour
  pollIntervalSec: number;
  maxReviewIters: number;
  maxTestAttempts: number;
  /**
   * Hard ceiling on the notional API cost (USD) of resolving ONE support case,
   * summed across every Agent SDK session it runs (triage + per-repo
   * implement/test/review/fix loops). It is the SOLE per-session ceiling — we
   * set no `maxTurns`, so a complex (= expensive) task runs until it finishes or
   * spends this budget. The cost is "notional" because the SDK authenticates
   * against a Claude subscription (no per-token billing), but it's a faithful
   * proxy for tokens spent, which is the real scarce resource against the plan's
   * rolling/weekly usage caps. Per-case advanced portal cases may raise it via a
   * stored `budgetUsd` override (see effectiveBudget in pipeline.ts).
   */
  maxBudgetPerCaseUsd: number;

  // Central backend (voltini.energy-backend). The worker keeps NO local DB —
  // central is the single source of truth for all case state. `centralApiBaseUrl`
  // is the backend origin (e.g. https://api.voltini.energy); `agentWorkerToken`
  // is the long-lived service token minted there with
  // `npm run mint:agent-worker-token`.
  centralApiBaseUrl: string;
  agentWorkerToken: string;

  // Per-case leasing (multi-worker mutual exclusion). The worker atomically
  // claims each case in central before working it, so two runs (an overlapping
  // restart, or a second worker instance) can't drive the same case at once.
  /**
   * This worker instance's identity, written as the lease owner. Defaults to
   * `<hostname>-<pid>`. Set a STABLE value per box (e.g. `bugfixer-1`) so a
   * restart reclaims its own in-flight case immediately instead of waiting out
   * the lease TTL; distinct values are REQUIRED when running several workers.
   */
  workerId: string;
  /**
   * Kill-switch. When false the worker skips claim/heartbeat/release entirely
   * and behaves exactly as before leasing existed (single-worker only). Also the
   * safe fallback path when running against a central too old to expose the
   * lease endpoints. Default true.
   */
  leasingEnabled: boolean;
}

function required(name: string): string {
  const v = process.env[name];
  if (v === undefined || v.trim() === "") {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v.trim();
}

function requiredInt(name: string): number {
  const raw = required(name);
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`Env var ${name} must be a positive integer, got: ${raw}`);
  }
  return n;
}

function requiredFloat(name: string): number {
  const raw = required(name);
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Env var ${name} must be a positive number, got: ${raw}`);
  }
  return n;
}

/** An optional env var with a fallback; blank/undefined → the fallback. */
function optional(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v.trim() === "" ? fallback : v.trim();
}

/** An optional boolean env var (`true`/`false`/`1`/`0`); default on blank. */
function optionalBool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v.trim() === "") return fallback;
  return /^(true|1|yes|on)$/i.test(v.trim());
}

export function loadConfig(): Config {
  const config: Config = {
    // Subscription auth: a long-lived OAuth token minted with `claude
    // setup-token`. The Agent SDK reads CLAUDE_CODE_OAUTH_TOKEN from the env.
    oauthToken: required("CLAUDE_CODE_OAUTH_TOKEN"),
    model: required("MODEL"),

    ghToken: required("GH_TOKEN"),
    botLogin: required("BOT_GH_LOGIN"),
    supportRepo: required("SUPPORT_REPO"),

    reposDir: required("REPOS_DIR"),

    pollIntervalSec: requiredInt("POLL_INTERVAL_SEC"),
    maxReviewIters: requiredInt("MAX_REVIEW_ITERS"),
    maxTestAttempts: requiredInt("MAX_TEST_ATTEMPTS"),
    maxBudgetPerCaseUsd: requiredFloat("MAX_BUDGET_PER_CASE_USD"),
    centralApiBaseUrl: required("CENTRAL_API_BASE_URL"),
    agentWorkerToken: required("AGENT_WORKER_TOKEN"),

    workerId: optional("WORKER_ID", `${hostname()}-${process.pid}`),
    leasingEnabled: optionalBool("AGENT_LEASING_ENABLED", true),
  };

  return config;
}
