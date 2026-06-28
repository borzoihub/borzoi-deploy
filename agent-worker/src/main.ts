import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { DateHelper } from "@digistrada/theworks-common";
import { loadConfig, type Config } from "./config.js";
import { GitHub, LABEL_IN_PROGRESS, LABEL_NEEDS_HUMAN, LABEL_WONTFIX } from "./github.js";
import { StateStore, type Phase, type RepoTaskRow } from "./state.js";
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

/**
 * REPOS_DIR is the one piece of config we can only validate against the
 * filesystem, and a missing/wrong path blocks the WHOLE worker — not one case.
 * If we let it slide, discoverRepos() throws deep inside per-case processing,
 * the generic catch in tick() swallows it as "will retry next tick", and the
 * worker spins forever with no operator-facing signal (and we must NOT comment
 * the infra error onto every customer issue). So fail fast and loud at startup
 * instead, with a message that says exactly what to fix.
 */
function validateReposDir(config: Config): void {
  const dir = config.reposDir;
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    console.error(
      `Fatal: REPOS_DIR does not exist (or is not a directory): ${dir}\n` +
        `  Create it and pre-clone the workable repos into it, e.g.:\n` +
        `    mkdir -p "${dir}" && git clone <repo> "${dir}/<name>"\n` +
        `  In Docker this must be a path INSIDE the container (a mounted volume),\n` +
        `  not a host path — check REPOS_DIR in .env against the compose volume mount.`,
    );
    process.exit(1);
  }
}

function setupGitAuth(config: Config): void {
  try {
    execFileSync("gh", ["auth", "setup-git"], {
      env: { ...process.env, GH_TOKEN: config.ghToken },
      stdio: "ignore",
    });
  } catch (e) {
    console.warn("gh auth setup-git failed (git push may not authenticate):", String(e));
  }
}

/** ISO timestamp prefix so an operator can see cadence and spot a stall. */
function ts(): string {
  return new Date().toISOString();
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

/** What the bot will (or won't) do with one repo sub-task, in plain words. */
function describeRepoTask(t: RepoTaskRow): string {
  switch (t.phase) {
    case "DONE":
      return "already has an open PR";
    case "NEEDS_HUMAN":
      return "parked for a human";
    case "BLOCKED":
      return "awaiting a human reply";
    case "PR":
      return "ready to open a PR";
    default:
      return `continuing work (${t.phase.toLowerCase()})`;
  }
}

/**
 * One human-readable status line per open ticket, derived from the resume
 * journal — mirrors the case phases in state.ts and the gates in pipeline.ts.
 */
function describeTicket(state: StateStore, issueNumber: number): string {
  const c = state.get(issueNumber);
  if (!c) return "New — queued for triage";

  switch (c.phase) {
    case "NEW":
      return "Not yet triaged — triaging now";
    case "BLOCKED":
      return "Awaiting a human reply";
    case "WONTFIX":
      return "Closed as won't-fix (not actionable)";
    case "NEEDS_HUMAN":
      return `Parked for a human${c.error ? `: ${c.error}` : ""}`;
    case "ABORTED":
      return `Aborted${c.error ? `: ${c.error}` : ""}`;
    // DONE and WORKING both describe their actual repo sub-tasks rather than
    // asserting an outcome — the real status lives in the per-repo rows.
    case "DONE":
    case "WORKING": {
      const repos = state.getRepoTasks(issueNumber);
      const [first] = repos;
      if (!first) return c.phase === "DONE" ? "Done" : "Continuing work";
      if (repos.length === 1) return capitalize(describeRepoTask(first));
      return repos.map((t) => `${t.repoKey} — ${describeRepoTask(t)}`).join("; ");
    }
  }
}

/**
 * Map GitHub's true state to the journal's case phase. GitHub (open/closed +
 * labels) is the real source of truth; the journal is a resume
 * cache that can drift — e.g. a human relabels/reopens an issue directly, or a
 * crash leaves the cache mid-phase. Reconciliation rewrites the cached phase to
 * whatever GitHub now says.
 *
 * Two phases are NOT representable on GitHub and are preserved when GitHub still
 * agrees the case is open + in-progress:
 *  - BLOCKED carries the Agent SDK sessionId needed to resume a parked question;
 *    on GitHub it looks identical to ordinary in-progress work.
 *  - NEEDS_HUMAN is an open issue wearing the needs-human label.
 */
function phaseFromGitHub(
  gh: { state: "open" | "closed"; labels: string[] },
  current: Phase,
): Phase {
  const set = new Set(gh.labels.map((l) => l.toLowerCase()));
  if (gh.state === "closed") {
    // A won't-fix close always carries the wontfix label (closeWontFix);
    // anything else closed is a resolved (or human "completed") close.
    return set.has(LABEL_WONTFIX) || set.has("duplicate") ? "WONTFIX" : "DONE";
  }
  if (set.has(LABEL_NEEDS_HUMAN)) return "NEEDS_HUMAN";
  if (set.has(LABEL_IN_PROGRESS)) {
    // in-progress can't distinguish active work from a parked Q&A — keep BLOCKED
    // so its sessionId survives the restart.
    return current === "BLOCKED" ? "BLOCKED" : "WORKING";
  }
  return "NEW";
}

/**
 * On startup, reconcile every journaled case's phase against GitHub. GitHub is
 * authoritative, so a drifted cache (e.g. from a manual GitHub action or a
 * crash) is corrected before the first poll. Only the case phase is touched; per-repo
 * sub-task recovery still happens lazily in the pipeline (it re-derives branch/PR
 * state from git reality when it next processes the case).
 */
function reconcileJournal(github: GitHub, state: StateStore): void {
  const cases = state.all();
  if (cases.length === 0) {
    console.log(`[${ts()}] reconcile: empty journal, nothing to sync.`);
    return;
  }
  let corrected = 0;
  for (const c of cases) {
    const gh = github.issueState(c.issueNumber);
    if (!gh) {
      console.log(
        `[${ts()}] reconcile: #${c.issueNumber} not found on GitHub — leaving journal phase ${c.phase} untouched.`,
      );
      continue;
    }
    const truth = phaseFromGitHub(gh, c.phase);
    if (truth !== c.phase) {
      console.log(
        `[${ts()}] reconcile: #${c.issueNumber} ${c.phase} → ${truth} (GitHub: ${gh.state}${gh.labels.length ? ` [${gh.labels.join(", ")}]` : ""}).`,
      );
      state.update(c.issueNumber, { phase: truth });
      corrected++;
    }
  }
  console.log(
    `[${ts()}] reconcile: synced ${cases.length} case(s) to GitHub, corrected ${corrected}.`,
  );
}

let tickCount = 0;

async function tick(deps: {
  config: Config;
  github: GitHub;
  state: StateStore;
  pipeline: Pipeline;
}): Promise<void> {
  const { github, state, pipeline } = deps;
  const n = ++tickCount;

  // Polling GitHub is itself a network round-trip; announce it so a slow/hung
  // `gh` call is distinguishable from an idle wait.
  console.log(`[${ts()}] tick #${n}: polling ${deps.config.supportRepo} for open tickets…`);
  const open = github.listOpen();

  // Make the fetch result explicit: zero tickets found must read differently
  // from "found tickets but nothing actionable" — they have different causes
  // (token/repo/access vs. all cases already triaged).
  if (open.length === 0) {
    console.log(
      `[${ts()}] tick #${n}: found NO open tickets in ${deps.config.supportRepo}. ` +
        `If you expect some, check GH_TOKEN access + SUPPORT_REPO. Nothing to do.`,
    );
    return;
  }
  // Register any new issues first so describeTicket() can read their journal row.
  for (const issue of open) {
    state.ensure(issue.number, issue.title);
  }
  const openNumbers = new Set(open.map((i) => i.number));

  // One line per ticket with its current status — what the bot sees and intends
  // to do with it this tick.
  for (const issue of open) {
    console.log(
      `[${ts()}] tick #${n}: Found ticket #${issue.number}: ${describeTicket(state, issue.number)}`,
    );
  }

  const parked = state.allInPhase("BLOCKED").filter((r) => openNumbers.has(r.issueNumber));
  const actionable = state
    .all()
    .filter((r) => ACTIONABLE_PHASES.includes(r.phase) && openNumbers.has(r.issueNumber));

  // 1. Resume any parked case whose human question has been answered.
  for (const row of parked) {
    console.log(`[${ts()}]   ↻ #${row.issueNumber}: checking for a human reply…`);
    try {
      await pipeline.resumeIfReplied(github.view(row.issueNumber), row);
    } catch (e) {
      console.error(`[${ts()}]   resume failed for #${row.issueNumber}:`, e);
    }
  }

  // 2. Drive actionable cases forward, sequentially.
  for (const row of actionable) {
    console.log(`[${ts()}]   ▶ #${row.issueNumber} (${row.phase}): processing…`);
    try {
      await pipeline.processCase(github.view(row.issueNumber), state.get(row.issueNumber)!);
    } catch (e) {
      console.error(`[${ts()}]   processing failed for #${row.issueNumber} (will retry next tick):`, e);
      state.update(row.issueNumber, { error: String(e) });
    }
  }

  if (actionable.length === 0 && parked.length === 0) {
    console.log(`[${ts()}] tick #${n}: nothing actionable — idle.`);
  } else {
    console.log(`[${ts()}] tick #${n}: done.`);
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  validateReposDir(config);
  DateHelper.setLocale("sv-SE");
  applyClaudeBackendEnv(config);

  const github = new GitHub(config);
  const state = new StateStore(config.stateDb);
  const runner = new ClaudeRunner(config);
  const pipeline = new Pipeline({ config, github, state, runner });

  setupGitAuth(config);
  github.ensureLabels();

  // GitHub is the source of truth; the journal is only a resume cache. Correct
  // any drift (e.g. a manual GitHub action or a crash) before the first poll.
  reconcileJournal(github, state);

  const intervalMs = DateHelper.duration(config.pollIntervalSec, "seconds").asMilliseconds();
  console.log(
    `[${ts()}] voltini-bugfixer started — repo ${config.supportRepo}, model ${config.model}, ` +
      `poll ${config.pollIntervalSec}s`,
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
      console.error(`[${ts()}] tick failed:`, e);
    }
    if (stopping) break;
    console.log(`[${ts()}] sleeping ${config.pollIntervalSec}s until next poll…`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  state.close();
  console.log(`[${ts()}] voltini-bugfixer stopped.`);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
