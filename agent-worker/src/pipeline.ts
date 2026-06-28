import type { Config } from "./config.js";
import type { GitHub, IssueDetail } from "./github.js";
import { LABEL_IN_PROGRESS, LABEL_NEEDS_HUMAN, RETRY_COMMAND } from "./github.js";
import type { StateStore, CaseRow, RepoTaskRow, RepoPhase } from "./state.js";
import { ShutdownError, type ClaudeRunner, type RunResult } from "./claude.js";
import {
  discoverRepos,
  findRepo,
  defaultBranch,
  ensureWorktree,
  freshWorktree,
  removeWorktree,
  localBranchExists,
  commitsAhead,
  hasWorktree,
  isWorktreeDirty,
  priorWorkSummary,
  type Repo,
} from "./repos.js";
import { triage } from "./triage.js";
import { implement, verifyTests } from "./implement.js";
import { review, reviewFix, isBlocking, formatFindings, type ReviewResult } from "./review.js";
import { openPr, findExistingPr } from "./pr.js";
import { buildAndLink, packageName, dependsOn } from "./linking.js";
import { resumeWithAnswerPrompt, type RepoScope } from "./prompts.js";

/**
 * Per-case state machine.
 *
 * A case can require fixes in several repos (a shared `*-common` change plus the
 * backend/frontend that consume it). Triage lists them all; each becomes a
 * sub-task driven independently through IMPLEMENT → TEST → REVIEW → PR, ending in
 * its own pull request. The case closes resolved only when EVERY sub-task has a
 * PR; if any repo can't converge — or a required repo isn't cloned — the whole
 * case falls back to needs-human rather than a partial auto-close.
 *
 * Customer-facing GitHub mutations only happen at the documented gates:
 *  - in-progress label once, when work starts (→ Under utredning)
 *  - close-resolved only after every repo's tests pass, review is clean, and a
 *    PR exists (→ Löst)
 *  - close-wontfix only when triage deems the case not actionable (→ Avvisad)
 */

export interface PipelineDeps {
  config: Config;
  github: GitHub;
  state: StateStore;
  runner: ClaudeRunner;
}

const REPO_TERMINAL: RepoPhase[] = ["DONE", "NEEDS_HUMAN"];

/**
 * Don't start an Agent SDK session with less than this much case budget left —
 * it would just immediately hit `error_max_budget_usd` having done nothing
 * useful. Treat "too little left to start" the same as "ran out mid-session".
 */
const MIN_SESSION_BUDGET_USD = 1.0;

export function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "fix"
  );
}

export class Pipeline {
  constructor(private readonly deps: PipelineDeps) {}

  private repoOrThrow(repoKey: string): Repo {
    const repo = findRepo(this.deps.config.reposDir, repoKey);
    if (!repo) {
      throw new Error(`Repo "${repoKey}" is no longer present in REPOS_DIR`);
    }
    return repo;
  }

  /** Human-readable, one-line progress narration for an operator watching logs. */
  private narrate(issueNumber: number, message: string): void {
    console.log(`▶ #${issueNumber}: ${message}`);
  }

  /** USD still available in this case's budget envelope (never negative). */
  private budgetRemaining(issueNumber: number): number {
    const spent = this.deps.state.get(issueNumber)?.costUsd ?? 0;
    return Math.max(0, this.deps.config.maxBudgetPerCaseUsd - spent);
  }

  /**
   * Record what a session cost against the case (and the repo that incurred it),
   * and log a running "$spent / $budget" line so an operator can watch the
   * envelope fill. Per-session and cumulative cost both land in the journal,
   * which is the durable per-bug cost record.
   */
  private charge(issueNumber: number, repoKey: string | null, costUsd: number, label: string): void {
    this.deps.state.addCost(issueNumber, repoKey, costUsd);
    const spent = this.deps.state.get(issueNumber)?.costUsd ?? 0;
    console.log(
      `[cost] #${issueNumber} ${label}: +$${costUsd.toFixed(4)} → $${spent.toFixed(2)} / $${this.deps.config.maxBudgetPerCaseUsd.toFixed(2)} this case`,
    );
  }

  /** Hard-fail one repo because the case ran out of budget during a phase. */
  private outOfBudgetRepo(issue: IssueDetail, task: RepoTaskRow, phaseLabel: string): void {
    const spent = this.deps.state.get(issue.number)?.costUsd ?? 0;
    const branchNote = task.branch ? ` Any committed work is on branch \`${task.branch}\`.` : "";
    this.needsHumanRepo(
      issue,
      task,
      `Hit the $${this.deps.config.maxBudgetPerCaseUsd.toFixed(0)} per-case budget during ${phaseLabel} ` +
        `(spent $${spent.toFixed(2)} on the case).${branchNote}`,
    );
  }

  private setPhase(issueNumber: number, phase: CaseRow["phase"], patch: Partial<CaseRow> = {}): void {
    this.deps.state.update(issueNumber, { ...patch, phase });
  }

  private setRepoPhase(
    issueNumber: number,
    repoKey: string,
    phase: RepoPhase,
    patch: Partial<RepoTaskRow> = {},
  ): void {
    this.deps.state.updateRepoTask(issueNumber, repoKey, { ...patch, phase });
  }

  /** The scope context handed to a repo's implement/review sessions. */
  private scopeFor(issueNumber: number, task: RepoTaskRow): RepoScope {
    const siblings = this.deps.state
      .getRepoTasks(issueNumber)
      .filter((t) => t.repoKey !== task.repoKey)
      .map((t) => t.repoKey);
    return { repoKey: task.repoKey, scope: task.scope ?? "", siblingRepoKeys: siblings };
  }

  private needsHumanCase(issue: IssueDetail, message: string): void {
    this.narrate(issue.number, `Handing off to a human: ${message}`);
    this.deps.github.addLabel(issue.number, LABEL_NEEDS_HUMAN);
    this.deps.github.comment(
      issue.number,
      `🤖 ${message}\n\n_A maintainer can re-run this case by commenting \`${RETRY_COMMAND}\`._`,
    );
    // Anchor for the /retry trigger: only a command posted AFTER this comment
    // re-arms the case (so old history can't re-fire it).
    const anchorId = this.deps.github.lastCommentId(issue.number) ?? null;
    this.setPhase(issue.number, "NEEDS_HUMAN", { error: message, needsHumanCommentId: anchorId });
  }

  /**
   * Re-run a parked needs-human case when an authorized maintainer comments
   * `/retry` after the hand-off. Customers can't trigger this — the gate is
   * write access to the support repo. Re-arming gives the case a FRESH budget
   * envelope (the maintainer is explicitly asking for another attempt) while the
   * lifetime cost record is preserved, resets any given-up repo sub-tasks, and
   * routes the case back through the normal recover→work path with the new
   * (generous) budget. No-op unless a qualifying command is present.
   */
  async retryIfRequested(issue: IssueDetail, row: CaseRow): Promise<void> {
    if (row.phase !== "NEEDS_HUMAN") return;
    // needsHumanCommentId may be null for a case parked before it was tracked —
    // then we scan all comments and rely on the reaction marker for idempotency.
    const cmd = this.deps.github.findUnhandledCommand(
      issue.number,
      row.needsHumanCommentId,
      RETRY_COMMAND,
    );
    if (!cmd) return;

    // Mark it handled FIRST (👀): visible to the maintainer and the idempotency
    // key, so this exact comment is never acted on twice — across ticks,
    // restarts, or multiple stacked /retry comments.
    this.deps.github.acknowledgeCommand(cmd.id);
    this.narrate(
      issue.number,
      `Maintainer @${cmd.author} requested \`${RETRY_COMMAND}\` — re-arming with a fresh $${this.deps.config.maxBudgetPerCaseUsd.toFixed(0)} budget.`,
    );
    // Fresh attempt budget (lifetime total is kept by addCost's separate column).
    this.deps.state.update(issue.number, { costUsd: 0, error: null, needsHumanCommentId: null });
    // Un-stick every sub-task that had given up, so the retry actually re-attempts
    // it. recoverExistingWork (run because we drop to NEW) then upgrades any with
    // committed/tested work straight back to TEST instead of redoing it.
    for (const t of this.deps.state.getRepoTasks(issue.number)) {
      if (t.phase === "NEEDS_HUMAN") {
        this.deps.state.updateRepoTask(issue.number, t.repoKey, {
          phase: "BRANCH",
          error: null,
          reviewIncomplete: false,
          testAttempts: 0,
          reviewIters: 0,
        });
      }
    }
    // Drop both labels + phase to NEW so the next processCase enters recovery.
    this.deps.github.removeLabel(issue.number, LABEL_NEEDS_HUMAN);
    this.deps.github.removeLabel(issue.number, LABEL_IN_PROGRESS);
    this.setPhase(issue.number, "NEW");
    this.deps.github.comment(issue.number, `🤖 Retrying this case now (requested by @${cmd.author}).`);

    await this.processCase(issue, this.deps.state.get(issue.number)!);
  }

  /** Park ONE repo sub-task on a human question; the case is BLOCKED overall. */
  private parkRepo(issue: IssueDetail, task: RepoTaskRow, resumePhase: RepoPhase, result: RunResult): void {
    const question = result.question ?? "I'm blocked but didn't record a question.";
    this.narrate(
      issue.number,
      `Paused on "${task.repoKey}" — waiting for a human to answer: ${question}`,
    );
    this.deps.github.comment(
      issue.number,
      `🤖❓ **Question from the support-fix bot** (about \`${task.repoKey}\`): ${question}\n\n_Reply to this issue and I'll continue._`,
    );
    const blockedCommentId = this.deps.github.lastCommentId(issue.number) ?? null;
    this.setRepoPhase(issue.number, task.repoKey, "BLOCKED", {
      resumePhase,
      sessionId: result.sessionId ?? null,
      blockedCommentId,
    });
    this.setPhase(issue.number, "BLOCKED");
  }

  /** Mark a single repo sub-task as needing a human; never auto-closes the case. */
  private needsHumanRepo(issue: IssueDetail, task: RepoTaskRow, message: string): void {
    this.narrate(issue.number, `"${task.repoKey}" needs a human: ${message}`);
    this.setRepoPhase(issue.number, task.repoKey, "NEEDS_HUMAN", { error: message });
  }

  /**
   * Soft-fail the advisory review read-pass when the case budget is exhausted:
   * advance the (already implemented + tested) repo to PR anyway, but flag the
   * review as incomplete so the case-close comment says so. This is the only
   * phase that ships on budget exhaustion rather than handing off to a human.
   */
  private skipReviewOnBudget(issue: IssueDetail, task: RepoTaskRow): void {
    this.narrate(
      issue.number,
      `"${task.repoKey}" hit the case budget before review finished — shipping the tested work and flagging the automated review as incomplete (soft-fail).`,
    );
    this.setRepoPhase(issue.number, task.repoKey, "PR", { reviewIncomplete: true });
  }

  /** Advance a case as far as possible this invocation. */
  async processCase(issue: IssueDetail, row: CaseRow): Promise<void> {
    if (row.phase === "NEW") {
      // First, recover any work a previous (possibly crashed, or pre-journal-wipe)
      // attempt left behind — an open PR or a branch with commits — so we never
      // start over on a case that's already done or half-done.
      const recovered = this.recoverExistingWork(issue);
      if (!recovered) {
        const planned = await this.triageAndPlan(issue);
        if (!planned) return; // terminal (wontfix / needs-human) already handled
      }
    }

    // Drive sub-tasks provider-first, so a shared `*-common` change is fully
    // implemented (and its PR open) before a repo that depends on it is built,
    // tested and linked against the local change.
    for (const task of this.orderedTasks(issue.number)) {
      if (REPO_TERMINAL.includes(task.phase)) continue;
      if (task.phase === "BLOCKED") continue; // resumed separately on human reply
      try {
        await this.driveRepoTask(issue, this.deps.state.getRepoTask(issue.number, task.repoKey)!);
      } catch (e) {
        // Operator shutdown: unwind without flagging needs-human or posting.
        if (e instanceof ShutdownError) throw e;
        // A hard error on one repo shouldn't sink the others; flag it and move on.
        this.needsHumanRepo(issue, task, `Error while working this repo: ${String(e)}`);
      }
    }

    this.finalize(issue);
  }

  /** Repo keys this consumer task depends on (its provider siblings), by package name. */
  private providerKeysFor(issueNumber: number, task: RepoTaskRow): string[] {
    const consumer = findRepo(this.deps.config.reposDir, task.repoKey);
    if (!consumer) return [];
    const out: string[] = [];
    for (const sib of this.deps.state.getRepoTasks(issueNumber)) {
      if (sib.repoKey === task.repoKey) continue;
      const sibRepo = findRepo(this.deps.config.reposDir, sib.repoKey);
      if (!sibRepo) continue;
      const pkg = packageName(sibRepo.path);
      if (pkg && dependsOn(consumer.path, pkg)) out.push(sib.repoKey);
    }
    return out;
  }

  /** Sub-tasks ordered upstream-first (providers before their consumers). */
  private orderedTasks(issueNumber: number): RepoTaskRow[] {
    const tasks = this.deps.state.getRepoTasks(issueNumber);
    return tasks
      .map((t) => ({ t, deps: this.providerKeysFor(issueNumber, t).length }))
      .sort((a, b) => a.deps - b.deps)
      .map((x) => x.t);
  }

  /**
   * Build + link every provider sibling into this consumer's worktree so it
   * compiles and tests against the local `*-common` change, not the registry.
   * Returns false (after flagging needs-human) if a provider isn't ready or a
   * link fails — the caller must not test against a stale dependency.
   */
  private linkProviders(issue: IssueDetail, task: RepoTaskRow, consumerWorktree: string): boolean {
    for (const pk of this.providerKeysFor(issue.number, task)) {
      const provRepo = this.repoOrThrow(pk);
      const provTask = this.deps.state.getRepoTask(issue.number, pk);
      if (!provTask?.branch) {
        this.needsHumanRepo(issue, task, `Sibling "${pk}" has no branch to link from.`);
        return false;
      }
      const provWorktree = ensureWorktree(provRepo, provTask.branch, defaultBranch(provRepo));
      if (!buildAndLink(consumerWorktree, task.repoKey, provWorktree, pk, this.deps.config)) {
        this.needsHumanRepo(issue, task, `Could not build/link sibling "${pk}" into this repo.`);
        return false;
      }
    }
    return true;
  }

  /**
   * A consumer must wait until each provider sibling is DONE. Returns "ready",
   * "wait" (defer to a later tick — a provider is still in flight) or "blocked"
   * (a provider gave up; this consumer can't proceed either).
   */
  private providerReadiness(issueNumber: number, task: RepoTaskRow): "ready" | "wait" | "blocked" {
    for (const pk of this.providerKeysFor(issueNumber, task)) {
      const pt = this.deps.state.getRepoTask(issueNumber, pk);
      if (!pt) continue;
      if (pt.phase === "NEEDS_HUMAN") return "blocked";
      if (pt.phase !== "DONE") return "wait";
    }
    return "ready";
  }

  /**
   * NEW → triage. Records a sub-task per repo the fix must touch, or terminates
   * the case (won't-fix / needs-human). Returns false if it terminated.
   */
  private async triageAndPlan(issue: IssueDetail): Promise<boolean> {
    this.narrate(issue.number, `Investigating "${issue.title}"…`);
    const reposDir = this.deps.config.reposDir;
    const available = discoverRepos(reposDir).map((r) => r.key);
    const result = await triage(this.deps.runner, reposDir, available, issue, this.budgetRemaining(issue.number));
    this.charge(issue.number, null, result.costUsd, "triage");

    if (result.limitHit) {
      // Couldn't even decide what to do within budget → escalate, don't guess.
      this.needsHumanCase(
        issue,
        `Triage hit the $${this.deps.config.maxBudgetPerCaseUsd.toFixed(0)} per-case budget before reaching a verdict.`,
      );
      return false;
    }

    if (!result.fixable) {
      this.narrate(issue.number, `Not actionable — marking won't-fix: ${result.reason}`);
      this.deps.github.closeWontFix(issue.number, `🤖 Closing as won't-fix: ${result.reason}`);
      this.setPhase(issue.number, "WONTFIX", { error: result.reason });
      return false;
    }

    if (result.repos.length === 0 && result.missingRepos.length === 0) {
      // Fixable, but triage named no repository at all to change — nothing to act on.
      this.needsHumanCase(
        issue,
        `This looks fixable but triage named no repository to change. ${result.reason}`,
      );
      return false;
    }

    const slug = slugify(issue.title);
    const branch = `features/${issue.number}-${slug}`;
    this.setPhase(issue.number, "WORKING", { slug, title: issue.title });

    // One workable sub-task per present repo…
    for (const t of result.repos) {
      this.deps.state.ensureRepoTask(issue.number, t.repoKey, { scope: t.scope, branch });
    }
    // …and a still-pending sub-task per required-but-missing repo. It stays in the
    // default BRANCH phase (NOT NEEDS_HUMAN): driveRepoTask just waits and retries
    // every tick until a human clones the repo into REPOS_DIR. The case can't
    // auto-resolve while part of the fix has nowhere to land, but it self-heals the
    // moment the repo appears — no manual journal reset needed.
    for (const t of result.missingRepos) {
      this.deps.state.ensureRepoTask(issue.number, t.repoKey, {
        scope: t.scope || "(repo not cloned yet — waiting)",
        branch,
      });
    }

    const repoList = result.repos.map((r) => r.repoKey).join(", ") || "(none cloned yet)";
    const missingNote = result.missingRepos.length
      ? ` (waiting for not-yet-cloned: ${result.missingRepos.map((r) => r.repoKey).join(", ")})`
      : "";
    this.narrate(
      issue.number,
      `Fixable — will open ${result.repos.length + result.missingRepos.length} PR(s) across: ${repoList}${missingNote}. Marking active.`,
    );
    this.deps.github.addLabel(issue.number, LABEL_IN_PROGRESS);
    return true;
  }

  /**
   * Before triaging, look for work a previous run already did for this issue —
   * even if our journal was wiped. The branch name is deterministic
   * (`features/<n>-<slug>`), so we can probe every available repo.
   *
   * We look LOCALLY FIRST — a crashed attempt leaves a branch/worktree right
   * here in the clone, no network needed:
   *  - in-progress (uncommitted) worktree → resume at IMPLEMENT (finish + commit)
   *  - committed branch, clean, no PR     → resume at TEST (verify → review → PR)
   *
   * GitHub is only consulted as a FALLBACK, for the one case the local clone
   * can't tell us about: a previous run that FINISHED — opened a PR and then
   * removed its worktree (the normal DONE cleanup). Then nothing survives
   * locally and the PR is the only evidence the work is already done.
   *
   * Returns true if anything was recovered (triage is then skipped).
   */
  private recoverExistingWork(issue: IssueDetail): boolean {
    const slug = slugify(issue.title);
    const branch = `features/${issue.number}-${slug}`;
    let recovered = false;

    for (const repo of discoverRepos(this.deps.config.reposDir)) {
      const base = defaultBranch(repo);

      // 1) Local signals — no network.
      const committed = localBranchExists(repo, branch) && commitsAhead(repo, branch, base) > 0;
      const dirty = isWorktreeDirty(repo, branch);

      if (committed && !dirty) {
        this.narrate(
          issue.number,
          `Found an existing branch "${branch}" in "${repo.key}" with committed work but no local PR record — resuming a crashed attempt: will verify, test, and open a PR.`,
        );
        // ensureRepoTask no-ops if the row already exists, so an original triage
        // scope survives. On a wiped journal it creates a row with no scope — the
        // resuming agent leans on the issue + the prior-work git summary instead
        // of a meaningless "(recovered…)" placeholder.
        this.deps.state.ensureRepoTask(issue.number, repo.key, { branch });
        this.setRepoPhase(issue.number, repo.key, "TEST");
        recovered = true;
        continue;
      }
      if (committed || dirty) {
        // Uncommitted (or mixed) changes in an existing worktree → DON'T discard
        // them and start over. Resume implementation so the agent finishes and
        // commits what's there, then it flows on to test/review/PR.
        this.narrate(
          issue.number,
          `Found an existing worktree for "${repo.key}" with in-progress (uncommitted) changes — resuming the fix instead of starting over.`,
        );
        this.deps.state.ensureRepoTask(issue.number, repo.key, { branch });
        this.setRepoPhase(issue.number, repo.key, "IMPLEMENT", { branch });
        recovered = true;
        continue;
      }
      if (hasWorktree(repo, branch)) {
        // An empty/clean leftover worktree — nothing to resume, but log it so the
        // restart isn't silent (it will be reset cleanly before fresh work).
        this.narrate(
          issue.number,
          `Found an empty leftover worktree for "${repo.key}" (no commits, no changes) — will reset it and start fresh.`,
        );
        continue;
      }

      // 2) No local trace — only NOW ask GitHub whether a finished run already
      //    opened a PR for this issue (worktree since cleaned up).
      const pr = findExistingPr(this.deps.config, repo, branch);
      if (pr && (pr.state === "open" || pr.state === "merged")) {
        this.narrate(
          issue.number,
          `No local work, but found an existing ${pr.state} PR for "${repo.key}" (${pr.url}) — assuming the work is done; updating the journal without re-checking.`,
        );
        this.deps.state.ensureRepoTask(issue.number, repo.key, { branch });
        this.setRepoPhase(issue.number, repo.key, "DONE", { prUrl: pr.url });
        recovered = true;
      } else if (pr) {
        // A closed-unmerged PR — don't silently redo or auto-close; flag it.
        this.narrate(
          issue.number,
          `No local work, but found a closed (unmerged) PR for "${repo.key}" (${pr.url}) — leaving this for a human rather than redoing it.`,
        );
        this.deps.state.ensureRepoTask(issue.number, repo.key, { branch });
        this.setRepoPhase(issue.number, repo.key, "NEEDS_HUMAN", {
          error: `A previous PR (${pr.url}) was closed without merging.`,
        });
        recovered = true;
      }
    }

    if (recovered) {
      this.setPhase(issue.number, "WORKING", { slug, title: issue.title });
      this.deps.github.addLabel(issue.number, LABEL_IN_PROGRESS);
    }
    return recovered;
  }

  /** Drive one repo sub-task IMPLEMENT → TEST → REVIEW → PR → DONE. */
  private async driveRepoTask(issue: IssueDetail, task: RepoTaskRow): Promise<void> {
    // Gate on provider siblings: don't start a consumer until the shared change
    // it depends on is implemented (DONE), and give up if a provider gave up.
    const readiness = this.providerReadiness(issue.number, task);
    if (readiness === "blocked") {
      const providers = this.providerKeysFor(issue.number, task).join(", ");
      return this.needsHumanRepo(issue, task, `Depends on sibling repo(s) (${providers}) that need a human.`);
    }
    if (readiness === "wait") {
      this.narrate(
        issue.number,
        `"${task.repoKey}" waits for its shared-dependency sibling(s) to finish first.`,
      );
      return;
    }

    // The repo may not be cloned yet. Rather than giving up (NEEDS_HUMAN), leave
    // the sub-task in place and retry on a later tick — the case self-heals the
    // moment a human clones the repo into REPOS_DIR.
    const repo = findRepo(this.deps.config.reposDir, task.repoKey);
    if (!repo) {
      this.narrate(
        issue.number,
        `Waiting for repo "${task.repoKey}" to be cloned into REPOS_DIR — will retry next tick.`,
      );
      // Tell the human once (idempotent on the marker, so the per-tick retry
      // never re-posts) that this case is parked on a missing repo.
      this.deps.github.commentOnce(
        issue.number,
        `waiting-repo:${task.repoKey}`,
        `🤖 This looks fixable, but the repository \`${task.repoKey}\` it needs isn't ` +
          `available to me yet. I'll start working automatically as soon as it's cloned ` +
          `into my workspace — no action needed on this issue.`,
      );
      return;
    }
    const base = defaultBranch(repo);
    const branch = task.branch ?? `features/${issue.number}-${slugify(issue.title)}`;
    const scope = this.scopeFor(issue.number, task);
    let phase = task.phase;

    if (phase === "BRANCH") {
      // Genuinely fresh work: start from a clean worktree off origin/<base> so a
      // half-finished previous attempt can't leak in. (Recovered/crashed work
      // never enters here — recoverExistingWork seeds it straight into TEST.)
      freshWorktree(repo, branch, base);
      this.setRepoPhase(issue.number, task.repoKey, "IMPLEMENT", { branch });
      phase = "IMPLEMENT";
    }

    const worktree = ensureWorktree(repo, branch, base);

    if (phase === "IMPLEMENT") {
      if (!this.linkProviders(issue, task, worktree)) return;
      const budget = this.budgetRemaining(issue.number);
      if (budget < MIN_SESSION_BUDGET_USD) return this.outOfBudgetRepo(issue, task, "implementation");
      this.narrate(issue.number, `Fixing "${task.repoKey}": ${task.scope ?? ""}`);
      // Feed any work a prior (crashed/recovered) attempt left on the branch so a
      // fresh session continues it instead of starting blind. Empty for genuinely
      // fresh work (clean worktree off base).
      const priorWork = priorWorkSummary(repo, branch, base);
      const result = await implement(this.deps.runner, this.deps.config, issue, worktree, budget, scope, priorWork);
      this.charge(issue.number, task.repoKey, result.costUsd, `implement (${task.repoKey})`);
      if (result.blocked) return this.parkRepo(issue, task, "IMPLEMENT", result);
      // A fix that didn't finish can't ship — hard-fail (the partial work stays
      // on the branch for a human).
      if (result.limitHit) return this.outOfBudgetRepo(issue, task, "implementation");
      if (result.isError) return this.needsHumanRepo(issue, task, "The implementation session errored out.");
      this.setRepoPhase(issue.number, task.repoKey, "TEST");
      phase = "TEST";
    }

    if (phase === "TEST") {
      // Re-link in case the implement session ran its own `npm install` and
      // dropped the local override — tests must see the sibling's local change.
      if (!this.linkProviders(issue, task, worktree)) return;
      const budget = this.budgetRemaining(issue.number);
      if (budget < MIN_SESSION_BUDGET_USD) return this.outOfBudgetRepo(issue, task, "test verification");
      this.narrate(issue.number, `Running "${task.repoKey}" test suite…`);
      const verdict = await verifyTests(this.deps.runner, worktree, budget);
      this.charge(issue.number, task.repoKey, verdict.costUsd, `test-verify (${task.repoKey})`);
      // Couldn't confirm pass/fail within budget → can't vouch the fix works.
      if (verdict.limitHit) return this.outOfBudgetRepo(issue, task, "test verification");
      if (!verdict.passed) {
        const attempts = (this.deps.state.getRepoTask(issue.number, task.repoKey)?.testAttempts ?? 0) + 1;
        this.deps.state.updateRepoTask(issue.number, task.repoKey, { testAttempts: attempts });
        this.narrate(
          issue.number,
          `"${task.repoKey}" tests failed (attempt ${attempts}/${this.deps.config.maxTestAttempts}): ${verdict.summary}`,
        );
        if (attempts >= this.deps.config.maxTestAttempts) {
          return this.needsHumanRepo(issue, task, `Tests still failing after ${attempts} attempts: ${verdict.summary}`);
        }
        const fixBudget = this.budgetRemaining(issue.number);
        if (fixBudget < MIN_SESSION_BUDGET_USD) return this.outOfBudgetRepo(issue, task, "implementation");
        this.narrate(issue.number, `Re-working "${task.repoKey}" to make tests pass…`);
        const fix = await implement(
          this.deps.runner,
          this.deps.config,
          issue,
          worktree,
          fixBudget,
          scope,
          priorWorkSummary(repo, branch, base),
        );
        this.charge(issue.number, task.repoKey, fix.costUsd, `implement-fix (${task.repoKey})`);
        if (fix.blocked) return this.parkRepo(issue, task, "IMPLEMENT", fix);
        if (fix.limitHit) return this.outOfBudgetRepo(issue, task, "implementation");
        if (fix.isError) return this.needsHumanRepo(issue, task, "The fix session errored out.");
        return this.driveRepoTask(issue, this.deps.state.getRepoTask(issue.number, task.repoKey)!);
      }
      this.setRepoPhase(issue.number, task.repoKey, "REVIEW");
      phase = "REVIEW";
    }

    if (phase === "REVIEW") {
      const budget = this.budgetRemaining(issue.number);
      let reviewResult: ReviewResult | undefined;
      if (budget >= MIN_SESSION_BUDGET_USD) {
        this.narrate(issue.number, `Self-reviewing "${task.repoKey}" (5 perspectives)…`);
        reviewResult = await review(this.deps.runner, worktree, base, budget);
        this.charge(issue.number, task.repoKey, reviewResult.costUsd, `review (${task.repoKey})`);
      }
      if (!reviewResult || reviewResult.limitHit) {
        // The review read-pass is advisory. When the budget runs out before it can
        // vouch for the (already implemented + tested) diff, SOFT-fail: ship the
        // work and flag the automated review as incomplete on close.
        this.skipReviewOnBudget(issue, task);
        phase = "PR";
      } else {
        const blocking = reviewResult.findings.filter(isBlocking);
        if (blocking.length > 0) {
          const iters = (this.deps.state.getRepoTask(issue.number, task.repoKey)?.reviewIters ?? 0) + 1;
          this.deps.state.updateRepoTask(issue.number, task.repoKey, { reviewIters: iters });
          this.narrate(
            issue.number,
            `Review of "${task.repoKey}" found ${blocking.length} blocking issue(s) — addressing them (iteration ${iters}).`,
          );
          if (iters > this.deps.config.maxReviewIters) {
            return this.needsHumanRepo(
              issue,
              task,
              `Review did not converge after ${this.deps.config.maxReviewIters} iterations. Outstanding:\n${formatFindings(blocking)}`,
            );
          }
          const fixBudget = this.budgetRemaining(issue.number);
          if (fixBudget < MIN_SESSION_BUDGET_USD) return this.outOfBudgetRepo(issue, task, "review fixes");
          const fix = await reviewFix(this.deps.runner, this.deps.config, issue, worktree, blocking, fixBudget, scope);
          this.charge(issue.number, task.repoKey, fix.costUsd, `review-fix (${task.repoKey})`);
          if (fix.blocked) return this.parkRepo(issue, task, "REVIEW", fix);
          // Unaddressed blocking findings shouldn't ship — hard-fail (unlike the
          // advisory read-pass above, fixing real findings is load-bearing).
          if (fix.limitHit) return this.outOfBudgetRepo(issue, task, "review fixes");
          if (fix.isError) return this.needsHumanRepo(issue, task, "The review-fix session errored out.");
          return this.driveRepoTask(issue, this.deps.state.getRepoTask(issue.number, task.repoKey)!);
        }
        this.setRepoPhase(issue.number, task.repoKey, "PR");
        phase = "PR";
      }
    }

    if (phase === "PR") {
      // Guard against opening a duplicate: a prior run may already have pushed
      // this branch and opened a PR (e.g. it crashed right after). Adopt it.
      const existing = findExistingPr(this.deps.config, repo, branch);
      if (existing && (existing.state === "open" || existing.state === "merged")) {
        this.narrate(issue.number, `A PR for "${task.repoKey}" already exists (${existing.url}) — adopting it instead of opening a duplicate.`);
        this.setRepoPhase(issue.number, task.repoKey, "DONE", { prUrl: existing.url });
        return;
      }
      this.narrate(issue.number, `Review clean — creating pull request for "${task.repoKey}"…`);
      const pr = openPr(this.deps.config, worktree, branch, base, issue, scope);
      this.setRepoPhase(issue.number, task.repoKey, "DONE", { prUrl: pr.url });
      this.narrate(issue.number, `PR opened for "${task.repoKey}": ${pr.url}`);
      // Worktree is retained until the whole case finalizes — a consumer sibling
      // may still need to build/link against this repo's local change.
    }
  }

  /**
   * Reclaim every sub-task's worktree disk once the case is settled. Branches
   * are intentionally KEPT — each opened PR needs its head branch — so this only
   * removes the local worktrees.
   */
  private cleanupWorktrees(issueNumber: number): void {
    for (const task of this.deps.state.getRepoTasks(issueNumber)) {
      if (!task.branch) continue;
      const repo = findRepo(this.deps.config.reposDir, task.repoKey);
      if (repo) removeWorktree(repo, task.branch);
    }
  }

  /**
   * After driving all sub-tasks, decide the case outcome:
   *  - any blocked        → stay BLOCKED (wait for a human reply)
   *  - all DONE           → close resolved, listing every PR
   *  - any needs-human    → needs-human, listing whatever PRs did get opened
   */
  private finalize(issue: IssueDetail): void {
    const tasks = this.deps.state.getRepoTasks(issue.number);
    if (tasks.length === 0) return;

    if (tasks.some((t) => t.phase === "BLOCKED")) {
      this.setPhase(issue.number, "BLOCKED");
      return;
    }
    if (tasks.every((t) => t.phase === "DONE")) {
      const prLines = tasks.map((t) => `- \`${t.repoKey}\`: ${t.prUrl}`).join("\n");
      const incomplete = tasks.filter((t) => t.reviewIncomplete).map((t) => t.repoKey);
      const caveat = incomplete.length
        ? `\n\n⚠️ Automated review didn't fully complete for ${incomplete.map((k) => `\`${k}\``).join(", ")} ` +
          `(reached the per-case budget). The fix and its tests passed; a maintainer should give the PR${incomplete.length > 1 ? "s" : ""} an extra look before merge.`
        : "";
      const spent = this.deps.state.get(issue.number)?.costUsd ?? 0;
      this.narrate(
        issue.number,
        `Done — all ${tasks.length} PR(s) opened, closing as resolved. Case cost: $${spent.toFixed(2)}${incomplete.length ? ` (review incomplete: ${incomplete.join(", ")})` : ""}.`,
      );
      this.deps.github.closeResolved(
        issue.number,
        `🤖 Fixed${incomplete.length ? "" : " and reviewed"}. Pull request(s):\n${prLines}${caveat}`,
      );
      this.setPhase(issue.number, "DONE");
      this.cleanupWorktrees(issue.number);
      return;
    }

    // Some repos are still in flight (e.g. one done, one needs-human). If none
    // are still actionable, fall back to needs-human with a status breakdown.
    const stillActionable = tasks.some((t) => !REPO_TERMINAL.includes(t.phase) && t.phase !== "BLOCKED");
    if (stillActionable) return; // more to do next tick

    const opened = tasks.filter((t) => t.phase === "DONE");
    const stuck = tasks.filter((t) => t.phase === "NEEDS_HUMAN");
    const lines = [
      ...opened.map((t) => `- \`${t.repoKey}\`: PR opened — ${t.prUrl}`),
      ...stuck.map((t) => `- \`${t.repoKey}\`: needs a human — ${t.error ?? "unresolved"}`),
    ].join("\n");
    this.needsHumanCase(
      issue,
      `This case spans multiple repos and not all could be completed autonomously:\n${lines}`,
    );
    this.cleanupWorktrees(issue.number);
  }

  /** Continue parked sub-tasks once a human has replied to their question(s). */
  async resumeIfReplied(issue: IssueDetail, _row: CaseRow): Promise<void> {
    const blocked = this.deps.state
      .getRepoTasks(issue.number)
      .filter((t) => t.phase === "BLOCKED");
    if (blocked.length === 0) return;

    let resumedAny = false;
    for (const task of blocked) {
      if (!task.blockedCommentId || !task.sessionId || !task.branch || !task.resumePhase) continue;
      const reply = this.deps.github.humanReplyAfter(issue.number, task.blockedCommentId);
      if (!reply) continue; // still waiting on this one

      this.narrate(issue.number, `Got a human reply for "${task.repoKey}" — resuming…`);
      const repo = this.repoOrThrow(task.repoKey);
      const base = defaultBranch(repo);
      const worktree = ensureWorktree(repo, task.branch, base);

      const budget = this.budgetRemaining(issue.number);
      if (budget < MIN_SESSION_BUDGET_USD) {
        this.outOfBudgetRepo(issue, task, "the resumed session");
        resumedAny = true;
        continue;
      }
      const result = await this.deps.runner.run({
        label: `resume #${issue.number} (${task.repoKey})`,
        cwd: worktree,
        resume: task.sessionId,
        prompt: resumeWithAnswerPrompt(reply.body),
        enableAskHuman: true,
        maxTurns: this.deps.config.maxImplementTurns,
        maxBudgetUsd: budget,
      });
      this.charge(issue.number, task.repoKey, result.costUsd, `resume (${task.repoKey})`);
      if (result.blocked) {
        this.parkRepo(issue, task, task.resumePhase, result);
        continue;
      }
      if (result.limitHit) {
        this.outOfBudgetRepo(issue, task, "the resumed session");
        resumedAny = true;
        continue;
      }
      if (result.isError) {
        this.needsHumanRepo(issue, task, "The resumed session errored out.");
        resumedAny = true;
        continue;
      }
      // Resumed work done; re-enter this repo at the next phase.
      const nextPhase: RepoPhase = task.resumePhase === "IMPLEMENT" ? "TEST" : "REVIEW";
      this.setRepoPhase(issue.number, task.repoKey, nextPhase, { blockedCommentId: null });
      resumedAny = true;
    }

    if (resumedAny) {
      this.setPhase(issue.number, "WORKING");
      await this.processCase(issue, this.deps.state.get(issue.number)!);
    }
  }
}
