import { existsSync, statSync } from "node:fs";
import { loadConfig } from "./config.js";
import { GitHub } from "./github.js";
import { phaseFromGitHub } from "./githubPhase.js";
import { StateStore, type Phase } from "./state.js";
import { discoverRepos, type Repo } from "./repos.js";
import { findExistingPr } from "./pr.js";

/**
 * One-shot backfill: seed central from existing GitHub history.
 *
 * Run once when switching the worker to central state (the old local SQLite
 * journal is discarded). Not part of the poll loop — invoke with
 * `npm run backfill`.
 *
 * What it CAN recover from GitHub:
 *  - every support case (open + closed) and its case-level worker phase,
 *    derived from issue state + labels (same mapping as the startup reconcile);
 *  - PR links — by probing each repo in REPOS_DIR for the deterministic
 *    `features/<n>-<slug>` branch.
 *
 * What it CANNOT recover (only ever lived in the discarded local SQLite):
 *  - cost (`cost_usd` / `lifetime_cost_usd`) — historical cases show $0;
 *  - per-repo fix summaries / the case solution summary — never structured.
 * Both are captured in full for NEW work going forward.
 */

/** Mirror of `pipeline.slugify` — the deterministic branch name component. */
function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "fix"
  );
}

/** Phases that may have produced a branch/PR worth probing for. */
const PR_BEARING: Phase[] = ["WORKING", "DONE", "BLOCKED", "NEEDS_HUMAN"];

function discoverReposSafe(reposDir: string): Repo[] {
  if (!existsSync(reposDir) || !statSync(reposDir).isDirectory()) {
    console.warn(
      `REPOS_DIR not found (${reposDir}) — seeding case phases only, skipping PR-link discovery.`,
    );
    return [];
  }
  return discoverRepos(reposDir);
}

async function main(): Promise<void> {
  const config = loadConfig();
  // gh subprocesses (incl. findExistingPr's PR probe) authenticate off this.
  process.env["GH_TOKEN"] = config.ghToken;

  const github = new GitHub(config);
  const state = new StateStore(config.centralApiBaseUrl, config.agentWorkerToken);
  const repos = discoverReposSafe(config.reposDir);

  const issues = github.listAll();
  console.log(
    `[backfill] ${issues.length} support issue(s) in ${config.supportRepo} → central (${config.centralApiBaseUrl}). ` +
      `${repos.length} repo(s) available for PR-link discovery.`,
  );

  let seeded = 0;
  let casesWithPr = 0;
  let prsLinked = 0;

  for (const issue of issues) {
    // ensure() is idempotent; keep an existing phase only to preserve BLOCKED
    // (so a re-run doesn't clobber a parked session the worker still holds).
    const existing = await state.get(issue.number);
    await state.ensure(issue.number, issue.title);
    const phase = phaseFromGitHub(
      { state: issue.state, labels: issue.labels },
      existing?.phase ?? "NEW",
    );
    await state.update(issue.number, { phase, title: issue.title });
    seeded++;

    if (!PR_BEARING.includes(phase) || repos.length === 0) {
      console.log(`[backfill]   #${issue.number} → ${phase}`);
      continue;
    }

    const branch = `features/${issue.number}-${slugify(issue.title)}`;
    let linkedHere = 0;
    for (const repo of repos) {
      const pr = findExistingPr(config, repo, branch);
      if (!pr) continue;
      await state.ensureRepoTask(issue.number, repo.key, { branch });
      // Record the PR link + mark the sub-task DONE (a PR exists). Cost stays 0.
      await state.updateRepoTask(issue.number, repo.key, {
        phase: "DONE",
        prUrl: pr.url,
        branch,
      });
      prsLinked++;
      linkedHere++;
    }
    if (linkedHere > 0) casesWithPr++;
    console.log(
      `[backfill]   #${issue.number} → ${phase}${linkedHere ? ` (${linkedHere} PR link(s))` : ""}`,
    );
  }

  console.log(
    `[backfill] done — seeded ${seeded} case(s); ${casesWithPr} with PR link(s) (${prsLinked} PR(s) total). ` +
      `Cost and solution summaries are $0/empty for these historical cases (unrecoverable) and captured fully for new work.`,
  );
  process.exit(0);
}

main().catch((e) => {
  console.error("[backfill] failed:", e);
  process.exit(1);
});
