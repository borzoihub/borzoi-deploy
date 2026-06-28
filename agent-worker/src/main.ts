import { execFileSync } from "node:child_process";
import { DateHelper } from "@digistrada/theworks-common";
import { loadConfig, type Config } from "./config.js";
import { GitHub } from "./github.js";
import { StateStore, type Phase } from "./state.js";
import { ClaudeRunner } from "./claude.js";
import { Pipeline } from "./pipeline.js";

/**
 * Entry point: validate config, prepare git/gh auth, then poll the support
 * tracker forever. Each tick resumes parked cases that got a reply, registers
 * new issues, and drives actionable cases forward — one at a time, sequentially
 * (a long case holds the line; that's intentional for a single-box worker).
 */

// Case-level phases the poll loop should drive forward. Per-repo progress lives
// in the sub-tasks; a case is actionable while it's untriaged or has work left.
const ACTIONABLE_PHASES: Phase[] = ["NEW", "WORKING"];

/**
 * Surface the subscription OAuth token into the environment the Claude Agent
 * SDK reads (CLAUDE_CODE_OAUTH_TOKEN). Done once at startup so spawned Claude
 * Code sessions inherit it and authenticate against the subscription.
 */
function applyClaudeBackendEnv(config: Config): void {
  process.env["CLAUDE_CODE_OAUTH_TOKEN"] = config.oauthToken;
}

function setupGitAuth(config: Config): void {
  if (config.dryRun) return;
  try {
    execFileSync("gh", ["auth", "setup-git"], {
      env: { ...process.env, GH_TOKEN: config.ghToken },
      stdio: "ignore",
    });
  } catch (e) {
    console.warn("gh auth setup-git failed (git push may not authenticate):", String(e));
  }
}

async function tick(deps: {
  config: Config;
  github: GitHub;
  state: StateStore;
  pipeline: Pipeline;
}): Promise<void> {
  const { github, state, pipeline } = deps;

  const open = github.listOpen();
  for (const issue of open) {
    state.ensure(issue.number, issue.title);
  }
  const openNumbers = new Set(open.map((i) => i.number));

  // 1. Resume any parked case whose human question has been answered.
  for (const row of state.allInPhase("BLOCKED")) {
    if (!openNumbers.has(row.issueNumber)) continue;
    try {
      await pipeline.resumeIfReplied(github.view(row.issueNumber), row);
    } catch (e) {
      console.error(`Resume failed for #${row.issueNumber}:`, e);
    }
  }

  // 2. Drive actionable cases forward, sequentially.
  for (const row of state.all()) {
    if (!ACTIONABLE_PHASES.includes(row.phase)) continue;
    if (!openNumbers.has(row.issueNumber)) continue; // closed externally
    try {
      await pipeline.processCase(github.view(row.issueNumber), state.get(row.issueNumber)!);
    } catch (e) {
      console.error(`Processing failed for #${row.issueNumber} (will retry next tick):`, e);
      state.update(row.issueNumber, { error: String(e) });
    }
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  DateHelper.setLocale("sv-SE");
  applyClaudeBackendEnv(config);

  const github = new GitHub(config);
  const state = new StateStore(config.stateDb);
  const runner = new ClaudeRunner(config);
  const pipeline = new Pipeline({ config, github, state, runner });

  setupGitAuth(config);
  github.ensureLabels();

  const intervalMs = DateHelper.duration(config.pollIntervalSec, "seconds").asMilliseconds();
  console.log(
    `voltini-bugfixer started — repo ${config.supportRepo}, model ${config.model}, ` +
      `poll ${config.pollIntervalSec}s${config.dryRun ? " [DRY-RUN]" : ""}`,
  );

  let stopping = false;
  const shutdown = () => {
    stopping = true;
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  while (!stopping) {
    try {
      await tick({ config, github, state, pipeline });
    } catch (e) {
      console.error("Tick failed:", e);
    }
    if (stopping) break;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  state.close();
  console.log("voltini-bugfixer stopped.");
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
