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
  // Claude backend. Env var names mirror borzoi-backend (BEDROCK_*); the Agent
  // SDK consumes the AWS standard chain, so main.ts maps these onto AWS_* +
  // CLAUDE_CODE_USE_BEDROCK at startup.
  useBedrock: boolean;
  model: string;
  bedrockRegion?: string;
  bedrockAccessKeyId?: string;
  bedrockSecretAccessKey?: string;
  anthropicApiKey?: string;

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
  stateDb: string;
  dryRun: boolean;
}

function required(name: string): string {
  const v = process.env[name];
  if (v === undefined || v.trim() === "") {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v.trim();
}

function optional(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v.trim() === "" ? undefined : v.trim();
}

function requiredInt(name: string): number {
  const raw = required(name);
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`Env var ${name} must be a positive integer, got: ${raw}`);
  }
  return n;
}

function bool(name: string): boolean {
  const v = optional(name);
  return v === "1" || v?.toLowerCase() === "true";
}

export function loadConfig(): Config {
  // Use Bedrock when its credentials are present (borzoi naming); otherwise
  // fall back to a first-party Anthropic key.
  const bedrockAccessKeyId = optional("BEDROCK_ACCESS_KEY_ID");
  const bedrockSecretAccessKey = optional("BEDROCK_SECRET_ACCESS_KEY");
  const anthropicApiKey = optional("ANTHROPIC_API_KEY");
  const useBedrock = Boolean(bedrockAccessKeyId && bedrockSecretAccessKey);

  if (!useBedrock && !anthropicApiKey) {
    throw new Error(
      "No Claude backend configured: set BEDROCK_ACCESS_KEY_ID + BEDROCK_SECRET_ACCESS_KEY (+ BEDROCK_REGION), or ANTHROPIC_API_KEY",
    );
  }

  const config: Config = {
    useBedrock,
    model: required("BEDROCK_MODEL"),
    bedrockRegion: optional("BEDROCK_REGION"),
    bedrockAccessKeyId,
    bedrockSecretAccessKey,
    anthropicApiKey,

    ghToken: required("GH_TOKEN"),
    botLogin: required("BOT_GH_LOGIN"),
    supportRepo: required("SUPPORT_REPO"),

    reposDir: required("REPOS_DIR"),

    pollIntervalSec: requiredInt("POLL_INTERVAL_SEC"),
    maxReviewIters: requiredInt("MAX_REVIEW_ITERS"),
    maxTestAttempts: requiredInt("MAX_TEST_ATTEMPTS"),
    maxImplementTurns: requiredInt("MAX_IMPLEMENT_TURNS"),
    stateDb: required("STATE_DB"),
    dryRun: bool("DRY_RUN"),
  };

  if (useBedrock && !config.bedrockRegion) {
    throw new Error("Bedrock credentials are set but BEDROCK_REGION is missing");
  }
  return config;
}
