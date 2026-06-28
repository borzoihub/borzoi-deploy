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
  maxImplementTurns: number;
  /**
   * Hard ceiling on the notional API cost (USD) of resolving ONE support case,
   * summed across every Agent SDK session it runs (triage + per-repo
   * implement/test/review/fix loops). It is the primary runaway guard — the
   * per-session turn caps are only a secondary backstop. The cost is "notional"
   * because the SDK authenticates against a Claude subscription (no per-token
   * billing), but it's a faithful proxy for tokens spent, which is the real
   * scarce resource against the plan's rolling/weekly usage caps.
   */
  maxBudgetPerCaseUsd: number;
  stateDb: string;
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
    maxImplementTurns: requiredInt("MAX_IMPLEMENT_TURNS"),
    maxBudgetPerCaseUsd: requiredFloat("MAX_BUDGET_PER_CASE_USD"),
    stateDb: required("STATE_DB"),
  };

  return config;
}
