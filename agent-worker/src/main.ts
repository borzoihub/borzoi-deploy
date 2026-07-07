import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { DateHelper } from "@digistrada/theworks-common";
import { loadConfig, type Config } from "./config.js";
import { GitHub, LABEL_NEEDS_HUMAN, LABEL_WONTFIX } from "./github.js";
import { phaseFromGitHub } from "./githubPhase.js";
import { StateStore, LostLeaseError, type Phase, type RepoTaskRow } from "./state.js";
import { ClaudeRunner, ShutdownError, PauseError } from "./claude.js";
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
async function describeTicket(state: StateStore, issueNumber: number): Promise<string> {
  const c = await state.get(issueNumber);
  if (!c) return "New — queued for triage";

  // Paused cases are excluded from every work set this tick, so don't describe
  // an intent ("triaging now") the bot won't act on — say it's paused instead.
  if (c.paused) return "Paused by operator — no action until resumed";

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
      const repos = await state.getRepoTasks(issueNumber);
      const [first] = repos;
      if (!first) return c.phase === "DONE" ? "Done" : "Continuing work";
      if (repos.length === 1) return capitalize(describeRepoTask(first));
      return repos.map((t) => `${t.repoKey} — ${describeRepoTask(t)}`).join("; ");
    }
  }
}

/**
 * On startup, reconcile every journaled case's phase against GitHub. GitHub is
 * authoritative, so a drifted cache (e.g. from a manual GitHub action or a
 * crash) is corrected before the first poll. Only the case phase is touched; per-repo
 * sub-task recovery still happens lazily in the pipeline (it re-derives branch/PR
 * state from git reality when it next processes the case).
 */
async function reconcileJournal(github: GitHub, state: StateStore): Promise<void> {
  const cases = await state.all();
  if (cases.length === 0) {
    console.log(`[${ts()}] reconcile: empty journal, nothing to sync.`);
    return;
  }
  let corrected = 0;
  for (const c of cases) {
    // Don't touch a case another worker is actively driving (live lease) — its
    // phase is mid-transition and central is authoritative for it, not GitHub's
    // eventually-consistent labels. (No-op for a single worker: nothing is leased
    // at startup.)
    if (c.leased) {
      console.log(`[${ts()}] reconcile: #${c.issueNumber} is leased by another worker — skipping.`);
      continue;
    }
    const gh = github.issueState(c.issueNumber);
    if (!gh) {
      console.log(
        `[${ts()}] reconcile: #${c.issueNumber} not found on GitHub — leaving journal phase ${c.phase} untouched.`,
      );
      continue;
    }
    // Self-heal the `closed + needs-human` contradiction (the #36 state): a
    // needs-human hand-off must live on an OPEN issue. Reopen it so it's a valid
    // parked case again, rather than leaving a closed issue that reads as
    // resolved to the customer. `phaseFromGitHub` maps this to NEEDS_HUMAN.
    const labelSet = new Set(gh.labels.map((l) => l.toLowerCase()));
    if (gh.state === "closed" && labelSet.has(LABEL_NEEDS_HUMAN) && !labelSet.has(LABEL_WONTFIX)) {
      console.warn(
        `[${ts()}] reconcile: #${c.issueNumber} is CLOSED but wears needs-human (contradiction — ` +
          `likely an overlapping-run artifact). Reopening to restore a valid parked state.`,
      );
      github.reopenIssue(c.issueNumber);
    }
    const truth = phaseFromGitHub(gh, c.phase);
    if (truth !== c.phase) {
      console.log(
        `[${ts()}] reconcile: #${c.issueNumber} ${c.phase} → ${truth} (GitHub: ${gh.state}${gh.labels.length ? ` [${gh.labels.join(", ")}]` : ""}).`,
      );
      await state.update(c.issueNumber, { phase: truth });
      corrected++;
    }
  }
  console.log(
    `[${ts()}] reconcile: synced ${cases.length} case(s) to GitHub, corrected ${corrected}.`,
  );
}

let tickCount = 0;

/**
 * Run one claimed work-set action: atomically claim the case's active-work lease,
 * run `fn`, then always release it. The claim is the single mutual-exclusion
 * primitive across the whole tick — no two live workers act on the same case.
 * Returns without running `fn` when another worker holds the lease. Claim is done
 * BEFORE `fn` so a command action (/retry, @-mention) reacts+drives exactly once:
 * the loser of the claim never reaches its 👀-reaction. A lost-lease abort inside
 * `fn` propagates to the caller (handled like a pause: stop, don't flag).
 */
async function underClaim(
  pipeline: Pipeline,
  issueNumber: number,
  fn: () => Promise<void>,
): Promise<void> {
  if (!(await pipeline.claim(issueNumber))) return;
  try {
    await fn();
  } finally {
    await pipeline.release(issueNumber);
  }
}

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
  // (token/repo/access vs. all cases already triaged). We do NOT return early:
  // completed cases are CLOSED (not in `open`), and their PRs still need the
  // follow-up-feedback pass below, which works off the journal independently.
  if (open.length === 0) {
    console.log(
      `[${ts()}] tick #${n}: found NO open tickets in ${deps.config.supportRepo}. ` +
        `If you expect some, check GH_TOKEN access + SUPPORT_REPO. ` +
        `Still checking completed PRs for maintainer feedback.`,
    );
  }
  // Register any new issues first so describeTicket() can read their journal row.
  for (const issue of open) {
    await state.ensure(issue.number, issue.title);
  }
  const openNumbers = new Set(open.map((i) => i.number));

  // One line per ticket with its current status — what the bot sees and intends
  // to do with it this tick.
  for (const issue of open) {
    console.log(
      `[${ts()}] tick #${n}: Found ticket #${issue.number}: ${await describeTicket(state, issue.number)}`,
    );
  }

  // 0. Consume portal-driven operator commands (retry / approve / guidance /
  // pr_feedback) queued in central on ANY case — open OR closed (a won't-fix
  // retry, PR feedback on a resolved case). These are the portal-side equivalent
  // of a maintainer's GitHub trigger; consumePendingCommand drives the case
  // itself, so a commanded case is excluded from the phase-based passes below this
  // tick to avoid double-processing.
  const commanded = new Set<number>();
  const withCommand = (await state.all()).filter((r) => r.pendingCommand && !r.paused);
  for (const row of withCommand) {
    let consumed = false;
    try {
      await underClaim(pipeline, row.issueNumber, async () => {
        const fresh = await state.get(row.issueNumber);
        if (fresh) consumed = await pipeline.consumePendingCommand(github.view(row.issueNumber), fresh);
      });
    } catch (e) {
      if (e instanceof ShutdownError) throw e;
      if (e instanceof PauseError || e instanceof LostLeaseError) continue;
      console.error(`[${ts()}]   command consume failed for #${row.issueNumber}:`, e);
    }
    if (consumed) commanded.add(row.issueNumber);
  }

  // Operator-paused cases are excluded from every work set below: a paused NEW
  // case is never picked up (it stays queued on the dashboard, no customer
  // notification), and a paused case already in flight isn't advanced/resumed/
  // retried/re-armed until the operator resumes it. (A case paused WHILE being
  // worked is stopped from inside processCase's pause watcher, not here.)
  // `commanded` cases were already driven by pass 0 this tick.
  const parked = (await state.allInPhase("BLOCKED")).filter(
    (r) => openNumbers.has(r.issueNumber) && !r.paused && !commanded.has(r.issueNumber),
  );
  const actionable = (await state.all()).filter(
    (r) =>
      ACTIONABLE_PHASES.includes(r.phase) &&
      openNumbers.has(r.issueNumber) &&
      !r.paused &&
      !commanded.has(r.issueNumber),
  );

  // 1. Resume any parked case whose human question has been answered.
  for (const row of parked) {
    console.log(`[${ts()}]   ↻ #${row.issueNumber}: checking for a human reply…`);
    try {
      await underClaim(pipeline, row.issueNumber, () =>
        pipeline.resumeIfReplied(github.view(row.issueNumber), row),
      );
    } catch (e) {
      if (e instanceof ShutdownError) throw e;
      if (e instanceof PauseError || e instanceof LostLeaseError) continue;
      console.error(`[${ts()}]   resume failed for #${row.issueNumber}:`, e);
    }
  }

  // 1.5 Re-run any needs-human case where an authorized maintainer commented
  // /retry. retryIfRequested drives the re-armed case itself, so these don't
  // need to also appear in the actionable pass below.
  const needsHuman = (await state.allInPhase("NEEDS_HUMAN")).filter(
    (r) => openNumbers.has(r.issueNumber) && !r.paused && !commanded.has(r.issueNumber),
  );
  for (const row of needsHuman) {
    try {
      await underClaim(pipeline, row.issueNumber, () =>
        pipeline.retryIfRequested(github.view(row.issueNumber), row),
      );
    } catch (e) {
      if (e instanceof ShutdownError) throw e;
      if (e instanceof PauseError || e instanceof LostLeaseError) continue;
      console.error(`[${ts()}]   retry check failed for #${row.issueNumber}:`, e);
    }
  }

  // 1.6 Re-arm a terminal case when an authorized maintainer @-mentions the bot on
  // the issue itself — the issue-side equivalent of the PR-feedback loop, and the
  // way to override a won't-fix close ("look at it anyway"). Won't-fix cases are
  // CLOSED, so they're NOT in `open` — fetch them from the journal. needsHuman
  // cases (open, loaded above) get the same @-mention path in addition to /retry.
  const wontfix = (await state.allInPhase("WONTFIX")).filter(
    (r) => !r.paused && !commanded.has(r.issueNumber),
  );
  const rearmable = [...wontfix, ...needsHuman];
  for (const row of rearmable) {
    try {
      await underClaim(pipeline, row.issueNumber, () =>
        pipeline.rearmOnIssueMention(github.view(row.issueNumber), row),
      );
    } catch (e) {
      if (e instanceof ShutdownError) throw e;
      if (e instanceof PauseError || e instanceof LostLeaseError) continue;
      console.error(`[${ts()}]   issue-mention check failed for #${row.issueNumber}:`, e);
    }
  }

  // 2. Drive actionable cases forward, sequentially.
  for (const row of actionable) {
    console.log(`[${ts()}]   ▶ #${row.issueNumber} (${row.phase}): processing…`);
    try {
      await underClaim(pipeline, row.issueNumber, async () =>
        pipeline.processCase(github.view(row.issueNumber), (await state.get(row.issueNumber))!),
      );
    } catch (e) {
      if (e instanceof ShutdownError) throw e;
      if (e instanceof PauseError) {
        // Operator paused it: in-flight work is committed and pushed to its
        // branch (so a human can review it) and the case is left at its persisted
        // phase. Don't flag needs-human — just stop touching it until resumed.
        console.log(`[${ts()}]   ⏸ #${row.issueNumber}: paused — committed work pushed to its branch; stopping until resumed.`);
        continue;
      }
      if (e instanceof LostLeaseError) {
        // Our lease expired and another worker reclaimed the case mid-run. The
        // session was aborted WITHOUT committing (the new owner may be writing the
        // branch). Leave it at its persisted phase for that owner; don't flag.
        console.log(`[${ts()}]   ⇄ #${row.issueNumber}: lease lost to another worker — stopping; it now owns the case.`);
        continue;
      }
      console.error(`[${ts()}]   processing failed for #${row.issueNumber} (will retry next tick):`, e);
      try {
        await state.update(row.issueNumber, { error: String(e) });
      } catch (updateErr) {
        console.error(`[${ts()}]   (could not record error centrally for #${row.issueNumber}):`, updateErr);
      }
    }
  }

  // 3. Watch completed cases' PRs for maintainer follow-up feedback. These issues
  // are CLOSED, so they are NOT in `open`/`openNumbers` — this pass works off the
  // journal independently. A case is watchable while it has a DONE sub-task with an
  // open PR we haven't stopped watching.
  const doneCases = (await state.allInPhase("DONE")).filter(
    (r) => !r.paused && !commanded.has(r.issueNumber),
  );
  const withPrFeedback: typeof doneCases = [];
  for (const c of doneCases) {
    const tasks = await state.getRepoTasks(c.issueNumber);
    if (tasks.some((t) => t.phase === "DONE" && t.prUrl && !t.prWatchClosed)) {
      withPrFeedback.push(c);
    }
  }
  for (const row of withPrFeedback) {
    console.log(`[${ts()}]   💬 #${row.issueNumber}: checking PR(s) for maintainer feedback…`);
    try {
      await underClaim(pipeline, row.issueNumber, () =>
        pipeline.addressPrFeedbackForCase(github.view(row.issueNumber)),
      );
    } catch (e) {
      if (e instanceof ShutdownError) throw e;
      if (e instanceof PauseError || e instanceof LostLeaseError) continue;
      console.error(`[${ts()}]   PR-feedback check failed for #${row.issueNumber}:`, e);
    }
  }

  if (
    actionable.length === 0 &&
    parked.length === 0 &&
    needsHuman.length === 0 &&
    withPrFeedback.length === 0
  ) {
    console.log(`[${ts()}] tick #${n}: nothing actionable — idle.`);
  } else {
    console.log(
      `[${ts()}] tick #${n}: done${needsHuman.length ? ` (watched ${needsHuman.length} needs-human case(s) for /retry)` : ""}.`,
    );
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  validateReposDir(config);
  DateHelper.setLocale("sv-SE");
  applyClaudeBackendEnv(config);

  const github = new GitHub(config);
  const state = new StateStore(config.centralApiBaseUrl, config.agentWorkerToken);
  const runner = new ClaudeRunner(config);
  const pipeline = new Pipeline({ config, github, state, runner });

  setupGitAuth(config);
  github.ensureLabels();

  // GitHub is the source of truth; the journal is only a resume cache. Correct
  // any drift (e.g. a manual GitHub action or a crash) before the first poll.
  await reconcileJournal(github, state);

  const intervalMs = DateHelper.duration(config.pollIntervalSec, "seconds").asMilliseconds();
  console.log(
    `[${ts()}] voltini-bugfixer started — repo ${config.supportRepo}, model ${config.model}, ` +
      `poll ${config.pollIntervalSec}s`,
  );

  let stopping = false;
  // Set while idle so the signal handler can cut the poll sleep short.
  let wake: (() => void) | undefined;
  // Release any held leases before dying so a restart doesn't wait out the TTL.
  // Bounded so an unreachable central can't hang the exit — a leaked lease self-
  // heals via its TTL, but a wedged shutdown does not.
  const releaseAndExit = async (code: number): Promise<never> => {
    try {
      await Promise.race([
        pipeline.releaseAll(),
        new Promise((r) => setTimeout(r, 2000)),
      ]);
    } catch {
      /* best-effort — never block exit on a release failure */
    }
    process.exit(code);
  };
  const shutdown = (signal: string) => {
    if (stopping) {
      // Second Ctrl-C/SIGTERM: skip the graceful unwind, but still make a
      // best-effort (bounded) lease release on the way out.
      console.log(`[${ts()}] ${signal} again — forcing exit (releasing held leases first).`);
      void releaseAndExit(130);
      return;
    }
    stopping = true;
    console.log(
      `[${ts()}] ${signal} received — stopping after the current task (aborting any running session). Press Ctrl-C again to force.`,
    );
    runner.shutdown(); // abort any in-flight Claude session so the tick unwinds now
    wake?.(); // break the idle sleep immediately
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  while (!stopping) {
    try {
      await tick({ config, github, state, pipeline });
    } catch (e) {
      // A shutdown abort unwinds the tick on purpose — not an error to report.
      if (!(e instanceof ShutdownError)) console.error(`[${ts()}] tick failed:`, e);
    }
    if (stopping) break;
    console.log(`[${ts()}] sleeping ${config.pollIntervalSec}s until next poll…`);
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        wake = undefined;
        resolve();
      }, intervalMs);
      wake = () => {
        clearTimeout(t);
        wake = undefined;
        resolve();
      };
    });
  }

  // Graceful stop: the in-flight tick has unwound (each `underClaim` finally
  // already released its own lease), but release anything still held so a
  // restart reclaims immediately instead of waiting out the TTL.
  const released = await pipeline.releaseAll();
  if (released > 0) console.log(`[${ts()}] released ${released} held lease(s) on shutdown.`);
  state.close();
  console.log(`[${ts()}] voltini-bugfixer stopped.`);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
