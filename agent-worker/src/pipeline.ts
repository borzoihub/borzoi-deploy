import type { Config } from "./config.js";
import type { GitHub, IssueDetail } from "./github.js";
import { LABEL_IN_PROGRESS, LABEL_NEEDS_HUMAN, LABEL_WONTFIX, RETRY_COMMAND } from "./github.js";
import type { StateStore, CaseRow, RepoTaskRow, RepoPhase } from "./state.js";
import { ShutdownError, PauseError, type ClaudeRunner, type RunResult } from "./claude.js";
import {
  discoverRepos,
  findRepo,
  defaultBranch,
  ensureWorktree,
  freshWorktree,
  mergeBaseIntoWorktree,
  removeWorktree,
  syncWorktreeToRemoteBranch,
  localBranchExists,
  findIssueBranch,
  commitsAhead,
  commitWorktree,
  hasWorktree,
  isWorktreeDirty,
  priorWorkSummary,
  repoSlug,
  type Repo,
} from "./repos.js";
import { triage, type ChangeKind } from "./triage.js";
import { explainRejection } from "./rejectionExplanation.js";
import { implement, addressPrFeedback, verifyTests } from "./implement.js";
import { review, reviewFix, isBlocking, formatFindings, type ReviewResult } from "./review.js";
import { openPr, findExistingPr, findExistingPrForIssue, parsePrNumber, pushBranch } from "./pr.js";
import type { PrComment } from "./github.js";
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
 * All case state lives in CENTRAL (`voltini.energy-backend`), reached over HTTP
 * via `StateStore` — the worker holds no local DB. Every state call is therefore
 * async; a failed call propagates so the tick retries rather than advancing on
 * stale state.
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

/** Cap on the per-repo fix summary persisted for the dashboard's resolved view. */
const MAX_FIX_SUMMARY_CHARS = 2000;

/**
 * How often the pause watcher re-reads central for this case's `paused` flag
 * while it's being worked. Central is the source of truth; the worker only
 * learns of a pause by polling it.
 */
const PAUSE_POLL_MS = 15_000;

/**
 * Grace given to a running session to finish (and commit) on its own after a
 * pause is requested, before the session is force-aborted. Pausing usually
 * means the ground shifted and the current work is likely to be redone, so we
 * don't let a long session run to completion — but a short one finishing
 * cleanly beats an aborted WIP commit. Two minutes splits the difference.
 */
const PAUSE_GRACE_MS = 120_000;

export function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "fix"
  );
}

/**
 * Branch folder per change classification. Support work is rarely a brand-new
 * feature, so triage classifies each case and we file it under the matching
 * folder: verified defects under `bugfix/`, betterments under `improvements/`,
 * genuinely new functionality under `features/`.
 */
const BRANCH_PREFIX: Record<ChangeKind, string> = {
  bugfix: "bugfix",
  improvement: "improvements",
  feature: "features",
};

/**
 * The branch a case's work lives on: `<prefix>/<issue#>-<slug>`. The prefix comes
 * from triage's classification; the slug is triage's short English description of
 * the fix (re-`slugify`d as a safety net). Deliberately carries NO installation
 * name — that's recoverable from the issue number in the branch. Falls back to
 * `bugfix` for an unrecognised kind.
 */
export function branchName(issueNumber: number, changeKind: ChangeKind, branchSlug: string): string {
  const prefix = BRANCH_PREFIX[changeKind] ?? "bugfix";
  return `${prefix}/${issueNumber}-${slugify(branchSlug)}`;
}

/** The slug portion of a `<prefix>/<n>-<slug>` branch — for recovery/display. */
export function slugFromBranch(branch: string): string {
  return branch.replace(/^[^/]+\/\d+-/, "") || branch;
}

/**
 * Whether a PR comment is addressed to the bot — i.e. @-mentions its GitHub
 * login. A bare mention is the trigger for a follow-up; comments that don't
 * mention the bot are ordinary review discussion and are left alone. Word-bounded
 * so `@voltini-bot` doesn't match `@voltini-bot-helper` (a different account).
 */
export function mentionsBot(body: string, botLogin: string): boolean {
  return new RegExp(`@${botLogin}(?![a-zA-Z0-9-])`, "i").test(body);
}

/** The PR comments that @-mention the bot, from a fetched feedback set. */
export function feedbackForBot(comments: PrComment[], botLogin: string): PrComment[] {
  return comments.filter((c) => mentionsBot(c.body, botLogin));
}

export class Pipeline {
  constructor(private readonly deps: PipelineDeps) {}

  /** Issue numbers an operator has paused, as seen by the running pause watcher.
   *  Read by `throwIfPaused` at phase boundaries to stop without an extra HTTP
   *  round-trip on every check. */
  private readonly pausedIssues = new Set<number>();

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

  // ── Operator pause ────────────────────────────────────────────────────────

  /**
   * Run `fn` (a whole processCase) under a pause watcher. The watcher polls
   * central for this case's `paused` flag; on pause it lets the current session
   * finish for a grace window (so its work commits normally), then force-aborts
   * it. Either way the abort/next-boundary surfaces as a PauseError, which we
   * catch here to commit any in-flight work before letting it propagate to the
   * tick (which logs "paused" and moves on — NOT needs-human). The case is left
   * on its committed branch at its persisted phase, ready to resume.
   */
  private async withPauseWatch<T>(issueNumber: number, fn: () => Promise<T>): Promise<T> {
    let detectedAt: number | null = null;
    const timer = setInterval(() => {
      void (async () => {
        let paused = false;
        try {
          paused = (await this.deps.state.get(issueNumber))?.paused ?? false;
        } catch {
          return; // transient central error — re-check next poll
        }
        if (!paused) return;
        if (detectedAt == null) {
          detectedAt = Date.now();
          this.pausedIssues.add(issueNumber);
          this.narrate(
            issueNumber,
            `Pause requested — stopping at the next safe point (force-stop in ${Math.round(PAUSE_GRACE_MS / 1000)}s).`,
          );
        } else if (Date.now() - detectedAt >= PAUSE_GRACE_MS) {
          console.log(`[pause] #${issueNumber}: grace elapsed — aborting the running session.`);
          this.deps.runner.requestPause();
        }
      })();
    }, PAUSE_POLL_MS);
    if (typeof timer.unref === "function") timer.unref();

    try {
      return await fn();
    } catch (e) {
      if (e instanceof PauseError) {
        this.narrate(issueNumber, "Paused by operator — committing in-flight work and stopping.");
        await this.commitPausedWork(issueNumber);
      }
      throw e;
    } finally {
      clearInterval(timer);
      this.pausedIssues.delete(issueNumber);
      this.deps.runner.clearPause();
    }
  }

  /** Throw if this case has been paused, to unwind at a safe phase boundary. Cheap
   *  (reads the watcher's set) so it can guard every session without an HTTP call. */
  private throwIfPaused(issueNumber: number): void {
    if (this.pausedIssues.has(issueNumber)) throw new PauseError();
  }

  /**
   * Commit whatever each of the case's repo worktrees currently holds and push
   * the branch, so a force-aborted session's work is preserved on its branch AND
   * visible on the remote for a human to review (reviewing in-flight work is a
   * common reason to pause). A resume then continues from it via
   * `priorWorkSummary`. Best-effort per repo; a clean worktree (the graceful
   * path — the session already committed) still gets pushed if the branch has
   * unpushed commits.
   */
  private async commitPausedWork(issueNumber: number): Promise<void> {
    let tasks: RepoTaskRow[];
    try {
      tasks = await this.deps.state.getRepoTasks(issueNumber);
    } catch (e) {
      console.error(`[pause] #${issueNumber}: could not load repo tasks to commit paused work:`, String(e));
      return;
    }
    for (const task of tasks) {
      if (!task.branch) continue;
      const repo = findRepo(this.deps.config.reposDir, task.repoKey);
      if (!repo) continue;
      if (commitWorktree(repo, task.branch, `WIP: paused by operator (#${issueNumber})`)) {
        this.narrate(issueNumber, `Committed in-flight work in "${task.repoKey}" before pausing.`);
      }
      // Push the branch so a human can review the paused work on the remote.
      // Only if the worktree exists (nothing to push otherwise) and best-effort
      // — an offline box or push failure must not mask the PauseError.
      if (!hasWorktree(repo, task.branch)) continue;
      try {
        const path = ensureWorktree(repo, task.branch, task.branch);
        pushBranch(this.deps.config, path, task.branch);
        this.narrate(issueNumber, `Pushed "${task.repoKey}" branch \`${task.branch}\` for review.`);
      } catch (e) {
        console.error(`[pause] #${issueNumber}: could not push ${task.repoKey} branch ${task.branch}:`, String(e));
      }
    }
  }

  /**
   * Record a granular activity step (triage/implement/test/review) on the case's
   * central timeline the moment that work starts. This is the internal, maintainer-
   * facing journal — it never changes the customer status (the app still shows a
   * single "in progress" throughout). Best-effort: the timeline is informational,
   * so a failed post is logged and swallowed rather than sinking the tick. Central
   * collapses consecutive duplicates, so a per-tick re-drive of the same phase
   * doesn't clutter the timeline.
   */
  private async recordActivity(
    issueNumber: number,
    kind: "triage" | "implement" | "test" | "review",
    repoKey: string | null = null,
  ): Promise<void> {
    try {
      await this.deps.state.recordEvent(issueNumber, kind, repoKey);
    } catch (e) {
      console.warn(
        `[timeline] #${issueNumber} could not record "${kind}"${repoKey ? ` (${repoKey})` : ""}:`,
        String(e),
      );
    }
  }

  /**
   * The spend ceiling for a case: its per-case `budgetUsd` override when set
   * (portal-authored advanced cases), otherwise the global
   * `config.maxBudgetPerCaseUsd`. Portal simple cases and every app case carry
   * no override, so they fall through to the global cap. `row` may be passed to
   * avoid a redundant fetch when the caller already has it.
   */
  private effectiveBudget(row: CaseRow | undefined): number {
    return row?.budgetUsd ?? this.deps.config.maxBudgetPerCaseUsd;
  }

  /** USD still available in this case's budget envelope (never negative). */
  private async budgetRemaining(issueNumber: number): Promise<number> {
    const row = await this.deps.state.get(issueNumber);
    const spent = row?.costUsd ?? 0;
    return Math.max(0, this.effectiveBudget(row) - spent);
  }

  /**
   * Record what a session cost against the case (and the repo that incurred it),
   * and log a running "$spent / $budget" line so an operator can watch the
   * envelope fill. The atomic central addCost returns the new running total, so
   * no follow-up read is needed. Cost lands centrally — the durable per-bug cost
   * record.
   */
  private async charge(
    issueNumber: number,
    repoKey: string | null,
    costUsd: number,
    label: string,
  ): Promise<void> {
    const spent = await this.deps.state.addCost(issueNumber, repoKey, costUsd);
    // Log against the case's effective cap (its override, else the global) so the
    // "$spent / $budget" line reflects the envelope actually in force.
    const cap = this.effectiveBudget(await this.deps.state.get(issueNumber));
    console.log(
      `[cost] #${issueNumber} ${label}: +$${costUsd.toFixed(4)} → $${spent.toFixed(2)} / $${cap.toFixed(2)} this case`,
    );
  }

  /** Hard-fail one repo because the case ran out of budget during a phase. */
  private async outOfBudgetRepo(issue: IssueDetail, task: RepoTaskRow, phaseLabel: string): Promise<void> {
    const spent = (await this.deps.state.get(issue.number))?.costUsd ?? 0;
    const branchNote = task.branch ? ` Any committed work is on branch \`${task.branch}\`.` : "";
    await this.needsHumanRepo(
      issue,
      task,
      `Hit the $${this.deps.config.maxBudgetPerCaseUsd.toFixed(0)} per-case budget during ${phaseLabel} ` +
        `(spent $${spent.toFixed(2)} on the case).${branchNote}`,
    );
  }

  private async setPhase(issueNumber: number, phase: CaseRow["phase"], patch: Partial<CaseRow> = {}): Promise<void> {
    await this.deps.state.update(issueNumber, { ...patch, phase });
  }

  private async setRepoPhase(
    issueNumber: number,
    repoKey: string,
    phase: RepoPhase,
    patch: Partial<RepoTaskRow> = {},
  ): Promise<void> {
    await this.deps.state.updateRepoTask(issueNumber, repoKey, { ...patch, phase });
  }

  /** The scope context handed to a repo's implement/review sessions. */
  private async scopeFor(issueNumber: number, task: RepoTaskRow): Promise<RepoScope> {
    const siblings = (await this.deps.state.getRepoTasks(issueNumber))
      .filter((t) => t.repoKey !== task.repoKey)
      .map((t) => t.repoKey);
    return { repoKey: task.repoKey, scope: task.scope ?? "", siblingRepoKeys: siblings };
  }

  private async needsHumanCase(issue: IssueDetail, message: string): Promise<void> {
    this.narrate(issue.number, `Handing off to a human: ${message}`);
    this.deps.github.addLabel(issue.number, LABEL_NEEDS_HUMAN);
    this.deps.github.comment(
      issue.number,
      `🤖 ${message}\n\n_A maintainer can re-run this case by commenting \`${RETRY_COMMAND}\`._`,
    );
    // Anchor for the /retry trigger: only a command posted AFTER this comment
    // re-arms the case (so old history can't re-fire it).
    const anchorId = this.deps.github.lastCommentId(issue.number) ?? null;
    // Always leave a readable account of what happened under "how it was solved"
    // — here: the bot did some work but couldn't finish autonomously and handed
    // the case to a person, with the reason why.
    await this.setPhase(issue.number, "NEEDS_HUMAN", {
      error: message,
      needsHumanCommentId: anchorId,
      solutionSummary: `Could not be resolved automatically and was handed over to a person for further handling. Reason: ${message}`,
    });
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
    await this.deps.state.update(issue.number, { costUsd: 0, error: null, needsHumanCommentId: null });
    // Un-stick every sub-task that had given up, so the retry actually re-attempts
    // it. recoverExistingWork (run because we drop to NEW) then upgrades any with
    // committed/tested work straight back to TEST instead of redoing it.
    for (const t of await this.deps.state.getRepoTasks(issue.number)) {
      if (t.phase === "NEEDS_HUMAN") {
        await this.deps.state.updateRepoTask(issue.number, t.repoKey, {
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
    await this.setPhase(issue.number, "NEW");
    this.deps.github.comment(issue.number, `🤖 Retrying this case now (requested by @${cmd.author}).`);

    await this.processCase(issue, (await this.deps.state.get(issue.number))!);
  }

  /**
   * Re-arm a terminal case (won't-fix or needs-human) when an authorized
   * maintainer @-mentions the bot on the ISSUE itself — the issue-side equivalent
   * of the post-completion PR-feedback loop, and the natural way to override a
   * won't-fix close. A won't-fix reflects the bot's OWN judgement that the case
   * isn't actionable; a maintainer outranks that, so an @-mention reopens the
   * issue, gives it a fresh budget envelope, and re-runs it — passing the
   * maintainer's instruction to triage as an authoritative directive so it
   * investigates instead of re-closing. No-op unless a qualifying mention is
   * present.
   *
   * Authorization + idempotency mirror `/retry`: the author must have write access
   * to the support repo (customers never do), and the bot 👀-reacts FIRST so a
   * single mention fires exactly once across ticks/restarts. The scan is anchored
   * to after the bot's close/hand-off comment.
   */
  async rearmOnIssueMention(issue: IssueDetail, row: CaseRow): Promise<void> {
    // Re-read: an earlier pass this tick (e.g. /retry) may already have moved the
    // case out of a terminal phase, making the passed-in snapshot stale.
    const current = await this.deps.state.get(issue.number);
    if (!current || (current.phase !== "WONTFIX" && current.phase !== "NEEDS_HUMAN")) return;

    const cmd = this.deps.github.findUnhandledMention(issue.number, current.needsHumanCommentId);
    if (!cmd) return;

    // React FIRST (👀): the durable idempotency marker AND a visible "picked it up"
    // signal, so this exact mention is never acted on twice.
    this.deps.github.acknowledgeCommand(cmd.id);
    this.narrate(
      issue.number,
      `Maintainer @${cmd.author} @-mentioned me to look again — re-arming with a fresh $${this.deps.config.maxBudgetPerCaseUsd.toFixed(0)} budget.`,
    );

    // A won't-fix case is CLOSED — reopen it (and drop the wontfix label) so the
    // customer-visible state reflects that it's being worked again. A needs-human
    // case is already open, so these are no-ops there.
    if (issue.state === "closed") this.deps.github.reopenIssue(issue.number);
    this.deps.github.removeLabel(issue.number, LABEL_WONTFIX);
    this.deps.github.removeLabel(issue.number, LABEL_NEEDS_HUMAN);
    this.deps.github.removeLabel(issue.number, LABEL_IN_PROGRESS);

    // Fresh attempt budget (lifetime total kept by addCost's separate column).
    await this.deps.state.update(issue.number, { costUsd: 0, error: null, needsHumanCommentId: null });
    // Un-stick every sub-task that had given up (relevant for a needs-human re-run;
    // a won't-fix case has none). recoverExistingWork then upgrades any with
    // committed/tested work straight back to TEST instead of redoing it.
    for (const t of await this.deps.state.getRepoTasks(issue.number)) {
      if (t.phase === "NEEDS_HUMAN") {
        await this.deps.state.updateRepoTask(issue.number, t.repoKey, {
          phase: "BRANCH",
          error: null,
          reviewIncomplete: false,
          testAttempts: 0,
          reviewIters: 0,
        });
      }
    }
    await this.setPhase(issue.number, "NEW");
    this.deps.github.comment(issue.number, `🤖 Taking another look at this (requested by @${cmd.author}).`);

    // Re-fetch the (now reopened) issue, and drive it with the maintainer's comment
    // as the triage override so a previously won't-fixed case is investigated.
    const reopened = this.deps.github.view(issue.number);
    await this.processCase(reopened, (await this.deps.state.get(issue.number))!, cmd.body);
  }

  /** Park ONE repo sub-task on a human question; the case is BLOCKED overall. */
  private async parkRepo(issue: IssueDetail, task: RepoTaskRow, resumePhase: RepoPhase, result: RunResult): Promise<void> {
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
    await this.setRepoPhase(issue.number, task.repoKey, "BLOCKED", {
      resumePhase,
      sessionId: result.sessionId ?? null,
      blockedCommentId,
    });
    await this.setPhase(issue.number, "BLOCKED");
  }

  /** Mark a single repo sub-task as needing a human; never auto-closes the case. */
  private async needsHumanRepo(issue: IssueDetail, task: RepoTaskRow, message: string): Promise<void> {
    this.narrate(issue.number, `"${task.repoKey}" needs a human: ${message}`);
    await this.setRepoPhase(issue.number, task.repoKey, "NEEDS_HUMAN", { error: message });
  }

  /**
   * Soft-fail the advisory review read-pass when the case budget is exhausted:
   * advance the (already implemented + tested) repo to PR anyway, but flag the
   * review as incomplete so the case-close comment says so. This is the only
   * phase that ships on budget exhaustion rather than handing off to a human.
   */
  private async skipReviewOnBudget(issue: IssueDetail, task: RepoTaskRow): Promise<void> {
    this.narrate(
      issue.number,
      `"${task.repoKey}" hit the case budget before review finished — shipping the tested work and flagging the automated review as incomplete (soft-fail).`,
    );
    await this.setRepoPhase(issue.number, task.repoKey, "PR", { reviewIncomplete: true });
  }

  /**
   * Tell the customer (status → "Under utredning") and stamp the frontend
   * timeline's "Agent started" event the MOMENT the bot picks a fresh case up —
   * BEFORE triage or any other AI work runs.
   *
   * Both effects flow from two writes:
   *  - the `in-progress` label makes `deriveStatus` return `in_progress` (→ *Under
   *    utredning*) and pushes the customer a status-change notification.
   *  - flipping the central phase off NEW makes the backend stamp
   *    `support_case.worker_started_at`, which the support-case timeline renders as
   *    the `picked_up` ("Agent started") event. Set once; never overwritten.
   *
   * Previously both only happened at the END of triage, so a reporter saw no
   * movement — and the timeline showed nothing — while the agent was already
   * investigating. Idempotent: callers gate on phase===NEW, and both writes are
   * safe to repeat.
   */
  private async markPickedUp(issue: IssueDetail): Promise<void> {
    this.narrate(issue.number, `Picking up "${issue.title}" — marking active (Under utredning) before starting work.`);
    this.deps.github.addLabel(issue.number, LABEL_IN_PROGRESS);
    await this.setPhase(issue.number, "WORKING", { title: issue.title });
  }

  /**
   * Advance a case as far as possible this invocation. `triageOverride`, when
   * present, is a maintainer's authoritative instruction (from an @-mention re-arm)
   * handed to triage so a previously not-actionable case is investigated rather
   * than re-closed won't-fix.
   */
  async processCase(issue: IssueDetail, row: CaseRow, triageOverride?: string): Promise<void> {
    // Under a pause watcher: if an operator pauses the case mid-run, the current
    // session finishes (grace) or is aborted, its work is committed, and a
    // PauseError propagates to the tick — leaving the case where it is to resume.
    return this.withPauseWatch(issue.number, () => this.processCaseInner(issue, row, triageOverride));
  }

  private async processCaseInner(issue: IssueDetail, row: CaseRow, triageOverride?: string): Promise<void> {
    this.throwIfPaused(issue.number);
    // Announce the pickup to the customer + timeline before doing any work.
    if (row.phase === "NEW") await this.markPickedUp(issue);

    // Triage/recover until the case has concrete repo sub-tasks. We gate on BOTH
    // "still NEW" and "no sub-tasks yet": the NEW arm preserves the re-armed
    // `/retry` path (which re-enters at NEW with its prior sub-tasks intact and
    // relies on recoverExistingWork to reclaim committed work); the no-sub-tasks
    // arm ensures a crash AFTER markPickedUp flipped the phase to WORKING but
    // BEFORE triage recorded anything still gets (re)triaged rather than stalling
    // as WORKING-with-nothing-to-drive.
    if (row.phase === "NEW" || (await this.deps.state.getRepoTasks(issue.number)).length === 0) {
      // First, recover any work a previous (possibly crashed, or pre-journal-wipe)
      // attempt left behind — an open PR or a branch with commits — so we never
      // start over on a case that's already done or half-done.
      const recovered = await this.recoverExistingWork(issue);
      if (!recovered) {
        const planned = await this.triageAndPlan(issue, triageOverride);
        if (!planned) return; // terminal (wontfix / needs-human) already handled
        // Plan-first review gate: a portal-authored `planOnly` case posts its
        // plan and parks for human approval BEFORE implementing. Only reached on
        // a fresh triage (not on the post-approval re-drive, which enters with
        // repo tasks already present and skips this whole block), so it never
        // re-fires. Approval is a human reply on the issue (see resumeIfReplied).
        const plannedCase = await this.deps.state.get(issue.number);
        if (plannedCase?.planOnly) {
          await this.postPlanForReview(issue);
          return;
        }
      }
    }

    // Drive sub-tasks provider-first, so a shared `*-common` change is fully
    // implemented (and its PR open) before a repo that depends on it is built,
    // tested and linked against the local change.
    for (const task of await this.orderedTasks(issue.number)) {
      if (REPO_TERMINAL.includes(task.phase)) continue;
      if (task.phase === "BLOCKED") continue; // resumed separately on human reply
      this.throwIfPaused(issue.number);
      try {
        await this.driveRepoTask(issue, (await this.deps.state.getRepoTask(issue.number, task.repoKey))!);
      } catch (e) {
        // Operator shutdown / pause: unwind without flagging needs-human or posting.
        if (e instanceof ShutdownError || e instanceof PauseError) throw e;
        // A hard error on one repo shouldn't sink the others; flag it and move on.
        await this.needsHumanRepo(issue, task, `Error while working this repo: ${String(e)}`);
      }
    }

    await this.finalize(issue);
  }

  /** Repo keys this consumer task depends on (its provider siblings), by package name. */
  private async providerKeysFor(issueNumber: number, task: RepoTaskRow): Promise<string[]> {
    const consumer = findRepo(this.deps.config.reposDir, task.repoKey);
    if (!consumer) return [];
    const out: string[] = [];
    for (const sib of await this.deps.state.getRepoTasks(issueNumber)) {
      if (sib.repoKey === task.repoKey) continue;
      const sibRepo = findRepo(this.deps.config.reposDir, sib.repoKey);
      if (!sibRepo) continue;
      const pkg = packageName(sibRepo.path);
      if (pkg && dependsOn(consumer.path, pkg)) out.push(sib.repoKey);
    }
    return out;
  }

  /** Sub-tasks ordered upstream-first (providers before their consumers). */
  private async orderedTasks(issueNumber: number): Promise<RepoTaskRow[]> {
    const tasks = await this.deps.state.getRepoTasks(issueNumber);
    const withDeps = await Promise.all(
      tasks.map(async (t) => ({ t, deps: (await this.providerKeysFor(issueNumber, t)).length })),
    );
    return withDeps.sort((a, b) => a.deps - b.deps).map((x) => x.t);
  }

  /**
   * Build + link every provider sibling into this consumer's worktree so it
   * compiles and tests against the local `*-common` change, not the registry.
   * Returns false (after flagging needs-human) if a provider isn't ready or a
   * link fails — the caller must not test against a stale dependency.
   */
  private async linkProviders(issue: IssueDetail, task: RepoTaskRow, consumerWorktree: string): Promise<boolean> {
    for (const pk of await this.providerKeysFor(issue.number, task)) {
      const provRepo = this.repoOrThrow(pk);
      const provTask = await this.deps.state.getRepoTask(issue.number, pk);
      if (!provTask?.branch) {
        await this.needsHumanRepo(issue, task, `Sibling "${pk}" has no branch to link from.`);
        return false;
      }
      const provWorktree = ensureWorktree(provRepo, provTask.branch, defaultBranch(provRepo));
      if (!buildAndLink(consumerWorktree, task.repoKey, provWorktree, pk, this.deps.config)) {
        await this.needsHumanRepo(issue, task, `Could not build/link sibling "${pk}" into this repo.`);
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
  private async providerReadiness(issueNumber: number, task: RepoTaskRow): Promise<"ready" | "wait" | "blocked"> {
    for (const pk of await this.providerKeysFor(issueNumber, task)) {
      const pt = await this.deps.state.getRepoTask(issueNumber, pk);
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
  private async triageAndPlan(issue: IssueDetail, override?: string): Promise<boolean> {
    this.throwIfPaused(issue.number);
    this.narrate(issue.number, `Investigating "${issue.title}"…`);
    // Timeline: the agent has entered triage (case-level, no repo yet).
    await this.recordActivity(issue.number, "triage");
    const reposDir = this.deps.config.reposDir;
    const available = discoverRepos(reposDir).map((r) => r.key);
    const result = await triage(
      this.deps.runner,
      reposDir,
      available,
      issue,
      await this.budgetRemaining(issue.number),
      override,
    );
    await this.charge(issue.number, null, result.costUsd, "triage");

    if (result.limitHit) {
      // Couldn't even decide what to do within budget → escalate, don't guess.
      await this.needsHumanCase(
        issue,
        `Triage hit the $${this.deps.config.maxBudgetPerCaseUsd.toFixed(0)} per-case budget before reaching a verdict.`,
      );
      return false;
    }

    if (!result.fixable) {
      this.narrate(issue.number, `Not actionable — marking won't-fix: ${result.reason}`);
      this.deps.github.closeWontFix(
        issue.number,
        `🤖 Closing as won't-fix: ${result.reason}\n\n` +
          `_If you think this should be looked at anyway, @${this.deps.config.botLogin} me on this ` +
          `issue with what to investigate and I'll reopen it and take another look._`,
      );
      // Anchor the @-mention re-arm trigger to AFTER this close comment, so an old
      // mention in the history can't re-open the case (mirrors the /retry anchor).
      const anchorId = this.deps.github.lastCommentId(issue.number) ?? null;
      // The homeowner sees `solutionSummary` verbatim as the reason their case was
      // declined. `result.reason` is produced while reading the internal repos, so
      // it can carry implementation detail or unverified guesses — run it through a
      // dedicated pass that rewrites it into a safe, honest, non-technical
      // explanation before it becomes customer-facing. The pass falls back to a
      // generic safe message on failure, never to the raw internal reason.
      const rejection = await explainRejection(
        this.deps.runner,
        this.deps.config.reposDir,
        issue,
        result.reason,
        await this.budgetRemaining(issue.number),
      );
      await this.charge(issue.number, null, rejection.costUsd, "reject-explain");
      await this.setPhase(issue.number, "WONTFIX", {
        // `error` keeps the internal rationale for operators (dashboard-only, not
        // shown to the homeowner); `solutionSummary` is the sanitised copy.
        error: result.reason,
        needsHumanCommentId: anchorId,
        solutionSummary: rejection.explanation,
      });
      return false;
    }

    if (result.repos.length === 0 && result.missingRepos.length === 0) {
      // Fixable, but triage named no repository at all to change — nothing to act on.
      await this.needsHumanCase(
        issue,
        `This looks fixable but triage named no repository to change. ${result.reason}`,
      );
      return false;
    }

    // Branch folder + slug come from triage's classification and English slug —
    // e.g. `bugfix/30-incorrect-case-title-in-support-list`. All repos in the case
    // share the one branch name.
    const branch = branchName(issue.number, result.changeKind, result.branchSlug);
    this.narrate(
      issue.number,
      `Classified as ${result.changeKind} — branch "${branch}".`,
    );
    await this.setPhase(issue.number, "WORKING", { slug: result.branchSlug, title: issue.title });

    // One workable sub-task per present repo…
    for (const t of result.repos) {
      await this.deps.state.ensureRepoTask(issue.number, t.repoKey, { scope: t.scope, branch });
    }
    // …and a still-pending sub-task per required-but-missing repo. It stays in the
    // default BRANCH phase (NOT NEEDS_HUMAN): driveRepoTask just waits and retries
    // every tick until a human clones the repo into REPOS_DIR. The case can't
    // auto-resolve while part of the fix has nowhere to land, but it self-heals the
    // moment the repo appears — no manual journal reset needed.
    for (const t of result.missingRepos) {
      await this.deps.state.ensureRepoTask(issue.number, t.repoKey, {
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
      `Fixable — will open ${result.repos.length + result.missingRepos.length} PR(s) across: ${repoList}${missingNote}.`,
    );
    // The case was already marked active (in-progress label + timeline start) at
    // pickup, before triage ran — see markPickedUp.
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
  private async recoverExistingWork(issue: IssueDetail): Promise<boolean> {
    let recovered = false;
    let recoveredSlug: string | null = null;

    for (const repo of discoverRepos(this.deps.config.reposDir)) {
      const base = defaultBranch(repo);

      // The branch's prefix + slug were chosen by a prior triage and aren't
      // reconstructable after a journal wipe, so we find it by issue number
      // (`<prefix>/<n>-<slug>`, any prefix — including legacy `features/`).
      const branch = findIssueBranch(repo, issue.number);

      if (branch) {
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
          await this.deps.state.ensureRepoTask(issue.number, repo.key, { branch });
          await this.setRepoPhase(issue.number, repo.key, "TEST");
          recovered = true;
          recoveredSlug ??= slugFromBranch(branch);
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
          await this.deps.state.ensureRepoTask(issue.number, repo.key, { branch });
          await this.setRepoPhase(issue.number, repo.key, "IMPLEMENT", { branch });
          recovered = true;
          recoveredSlug ??= slugFromBranch(branch);
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
      }

      // 2) No usable local branch — only NOW ask GitHub whether a finished run
      //    already opened a PR for this issue (worktree since cleaned up). Matched
      //    by issue number since the branch name isn't known locally.
      const pr = findExistingPrForIssue(this.deps.config, repo, issue.number);
      if (pr && (pr.state === "open" || pr.state === "merged")) {
        this.narrate(
          issue.number,
          `No local work, but found an existing ${pr.state} PR for "${repo.key}" (${pr.url}) — assuming the work is done; updating the journal without re-checking.`,
        );
        await this.deps.state.ensureRepoTask(issue.number, repo.key, { branch: pr.branch ?? branch ?? undefined });
        await this.setRepoPhase(issue.number, repo.key, "DONE", { prUrl: pr.url });
        recovered = true;
        recoveredSlug ??= pr.branch ? slugFromBranch(pr.branch) : null;
      } else if (pr) {
        // A closed-unmerged PR — don't silently redo or auto-close; flag it.
        this.narrate(
          issue.number,
          `No local work, but found a closed (unmerged) PR for "${repo.key}" (${pr.url}) — leaving this for a human rather than redoing it.`,
        );
        await this.deps.state.ensureRepoTask(issue.number, repo.key, { branch: pr.branch ?? branch ?? undefined });
        await this.setRepoPhase(issue.number, repo.key, "NEEDS_HUMAN", {
          error: `A previous PR (${pr.url}) was closed without merging.`,
        });
        recovered = true;
      }
    }

    if (recovered) {
      // Record the slug/title; the in-progress label + timeline start were already
      // applied at pickup (markPickedUp), so no label write is needed here.
      await this.setPhase(issue.number, "WORKING", { slug: recoveredSlug, title: issue.title });
    }
    return recovered;
  }

  /** Drive one repo sub-task IMPLEMENT → TEST → REVIEW → PR → DONE. */
  private async driveRepoTask(issue: IssueDetail, task: RepoTaskRow): Promise<void> {
    // Gate on provider siblings: don't start a consumer until the shared change
    // it depends on is implemented (DONE), and give up if a provider gave up.
    const readiness = await this.providerReadiness(issue.number, task);
    if (readiness === "blocked") {
      const providers = (await this.providerKeysFor(issue.number, task)).join(", ");
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
    // task.branch is set at triage/recovery; the fallbacks only guard a corrupt
    // row — prefer any existing branch for this issue, else a bugfix default.
    const branch =
      task.branch ??
      findIssueBranch(repo, issue.number) ??
      `bugfix/${issue.number}-${slugify(issue.title)}`;
    const scope = await this.scopeFor(issue.number, task);
    let phase = task.phase;

    if (phase === "BRANCH") {
      // Genuinely fresh work: start from a clean worktree off origin/<base> so a
      // half-finished previous attempt can't leak in. (Recovered/crashed work
      // never enters here — recoverExistingWork seeds it straight into TEST.)
      freshWorktree(repo, branch, base);
      await this.setRepoPhase(issue.number, task.repoKey, "IMPLEMENT", { branch });
      phase = "IMPLEMENT";
    }

    const worktree = ensureWorktree(repo, branch, base);

    // Always continue on top of the latest default branch. Whenever we pick up an
    // EXISTING branch to carry on — a crashed/committed attempt recovered at
    // TEST/REVIEW, or a case resumed at a persisted phase after a pause/restart —
    // merge the latest <base> in first, so tests, review and the eventual PR
    // reflect current main, not a stale base. Genuinely fresh work (phase===BRANCH)
    // was just created off origin/<base> by freshWorktree and needs no merge. A
    // dirty worktree (uncommitted work from a crashed IMPLEMENT) is skipped here
    // and brought up to date by the implement session itself (see priorWorkBlock);
    // an unresolvable conflict on a clean branch hands off to a human.
    if (task.phase !== "BRANCH") {
      const merge = mergeBaseIntoWorktree(repo, branch, base);
      if (merge === "conflict") {
        return this.needsHumanRepo(
          issue,
          task,
          `Could not automatically merge the latest \`${base}\` into branch \`${branch}\` before continuing — ` +
            `there are merge conflicts a maintainer needs to resolve.`,
        );
      }
      if (merge === "merged") {
        this.narrate(
          issue.number,
          `Merged latest \`${base}\` into "${task.repoKey}" branch \`${branch}\` before continuing.`,
        );
      }
    }

    if (phase === "IMPLEMENT") {
      this.throwIfPaused(issue.number);
      if (!(await this.linkProviders(issue, task, worktree))) return;
      const budget = await this.budgetRemaining(issue.number);
      if (budget < MIN_SESSION_BUDGET_USD) return this.outOfBudgetRepo(issue, task, "implementation");
      this.narrate(issue.number, `Fixing "${task.repoKey}": ${task.scope ?? ""}`);
      await this.recordActivity(issue.number, "implement", task.repoKey);
      // Feed any work a prior (crashed/recovered) attempt left on the branch so a
      // fresh session continues it instead of starting blind. Empty for genuinely
      // fresh work (clean worktree off base).
      const priorWork = priorWorkSummary(repo, branch, base);
      const result = await implement(this.deps.runner, this.deps.config, issue, worktree, budget, scope, priorWork, base);
      await this.charge(issue.number, task.repoKey, result.costUsd, `implement (${task.repoKey})`);
      if (result.blocked) return this.parkRepo(issue, task, "IMPLEMENT", result);
      // A fix that didn't finish can't ship — hard-fail (the partial work stays
      // on the branch for a human).
      if (result.limitHit) return this.outOfBudgetRepo(issue, task, "implementation");
      if (result.isError) return this.needsHumanRepo(issue, task, "The implementation session errored out.");
      // Capture the agent's own account of the fix for the dashboard.
      await this.recordFixSummary(issue.number, task.repoKey, result);
      await this.setRepoPhase(issue.number, task.repoKey, "TEST");
      phase = "TEST";
    }

    if (phase === "TEST") {
      this.throwIfPaused(issue.number);
      // Re-link in case the implement session ran its own `npm install` and
      // dropped the local override — tests must see the sibling's local change.
      if (!(await this.linkProviders(issue, task, worktree))) return;
      const budget = await this.budgetRemaining(issue.number);
      if (budget < MIN_SESSION_BUDGET_USD) return this.outOfBudgetRepo(issue, task, "test verification");
      this.narrate(issue.number, `Running "${task.repoKey}" test suite…`);
      await this.recordActivity(issue.number, "test", task.repoKey);
      const verdict = await verifyTests(this.deps.runner, worktree, budget);
      await this.charge(issue.number, task.repoKey, verdict.costUsd, `test-verify (${task.repoKey})`);
      // Couldn't confirm pass/fail within budget → can't vouch the fix works.
      if (verdict.limitHit) return this.outOfBudgetRepo(issue, task, "test verification");
      if (!verdict.passed) {
        const attempts = ((await this.deps.state.getRepoTask(issue.number, task.repoKey))?.testAttempts ?? 0) + 1;
        await this.deps.state.updateRepoTask(issue.number, task.repoKey, { testAttempts: attempts });
        this.narrate(
          issue.number,
          `"${task.repoKey}" tests failed (attempt ${attempts}/${this.deps.config.maxTestAttempts}): ${verdict.summary}`,
        );
        if (attempts >= this.deps.config.maxTestAttempts) {
          return this.needsHumanRepo(issue, task, `Tests still failing after ${attempts} attempts: ${verdict.summary}`);
        }
        const fixBudget = await this.budgetRemaining(issue.number);
        if (fixBudget < MIN_SESSION_BUDGET_USD) return this.outOfBudgetRepo(issue, task, "implementation");
        this.narrate(issue.number, `Re-working "${task.repoKey}" to make tests pass…`);
        await this.recordActivity(issue.number, "implement", task.repoKey);
        const fix = await implement(
          this.deps.runner,
          this.deps.config,
          issue,
          worktree,
          fixBudget,
          scope,
          priorWorkSummary(repo, branch, base),
          base,
        );
        await this.charge(issue.number, task.repoKey, fix.costUsd, `implement-fix (${task.repoKey})`);
        if (fix.blocked) return this.parkRepo(issue, task, "IMPLEMENT", fix);
        if (fix.limitHit) return this.outOfBudgetRepo(issue, task, "implementation");
        if (fix.isError) return this.needsHumanRepo(issue, task, "The fix session errored out.");
        await this.recordFixSummary(issue.number, task.repoKey, fix);
        return this.driveRepoTask(issue, (await this.deps.state.getRepoTask(issue.number, task.repoKey))!);
      }
      await this.setRepoPhase(issue.number, task.repoKey, "REVIEW");
      phase = "REVIEW";
    }

    if (phase === "REVIEW") {
      this.throwIfPaused(issue.number);
      const budget = await this.budgetRemaining(issue.number);
      let reviewResult: ReviewResult | undefined;
      if (budget >= MIN_SESSION_BUDGET_USD) {
        this.narrate(issue.number, `Self-reviewing "${task.repoKey}" (5 perspectives)…`);
        await this.recordActivity(issue.number, "review", task.repoKey);
        reviewResult = await review(this.deps.runner, worktree, base, budget);
        await this.charge(issue.number, task.repoKey, reviewResult.costUsd, `review (${task.repoKey})`);
      }
      if (!reviewResult || reviewResult.limitHit) {
        // The review read-pass is advisory. When the budget runs out before it can
        // vouch for the (already implemented + tested) diff, SOFT-fail: ship the
        // work and flag the automated review as incomplete on close.
        await this.skipReviewOnBudget(issue, task);
        phase = "PR";
      } else {
        const blocking = reviewResult.findings.filter(isBlocking);
        if (blocking.length > 0) {
          const iters = ((await this.deps.state.getRepoTask(issue.number, task.repoKey))?.reviewIters ?? 0) + 1;
          await this.deps.state.updateRepoTask(issue.number, task.repoKey, { reviewIters: iters });
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
          const fixBudget = await this.budgetRemaining(issue.number);
          if (fixBudget < MIN_SESSION_BUDGET_USD) return this.outOfBudgetRepo(issue, task, "review fixes");
          const fix = await reviewFix(this.deps.runner, this.deps.config, issue, worktree, blocking, fixBudget, scope);
          await this.charge(issue.number, task.repoKey, fix.costUsd, `review-fix (${task.repoKey})`);
          if (fix.blocked) return this.parkRepo(issue, task, "REVIEW", fix);
          // Unaddressed blocking findings shouldn't ship — hard-fail (unlike the
          // advisory read-pass above, fixing real findings is load-bearing).
          if (fix.limitHit) return this.outOfBudgetRepo(issue, task, "review fixes");
          if (fix.isError) return this.needsHumanRepo(issue, task, "The review-fix session errored out.");
          return this.driveRepoTask(issue, (await this.deps.state.getRepoTask(issue.number, task.repoKey))!);
        }
        await this.setRepoPhase(issue.number, task.repoKey, "PR");
        phase = "PR";
      }
    }

    if (phase === "PR") {
      // Guard against opening a duplicate: a prior run may already have pushed
      // this branch and opened a PR (e.g. it crashed right after). Adopt it.
      const existing = findExistingPr(this.deps.config, repo, branch);
      if (existing && (existing.state === "open" || existing.state === "merged")) {
        this.narrate(issue.number, `A PR for "${task.repoKey}" already exists (${existing.url}) — adopting it instead of opening a duplicate.`);
        await this.setRepoPhase(issue.number, task.repoKey, "DONE", { prUrl: existing.url });
        return;
      }
      this.narrate(issue.number, `Review clean — creating pull request for "${task.repoKey}"…`);
      const pr = openPr(this.deps.config, worktree, branch, base, issue, scope);
      await this.setRepoPhase(issue.number, task.repoKey, "DONE", { prUrl: pr.url });
      this.narrate(issue.number, `PR opened for "${task.repoKey}": ${pr.url}`);
      // Worktree is retained until the whole case finalizes — a consumer sibling
      // may still need to build/link against this repo's local change.
    }
  }

  /**
   * Persist the agent's own summary of what it fixed in this repo (used for the
   * dashboard's "how it was fixed" view). Best-effort — a missing summary just
   * leaves the field null; it must never derail the fix flow.
   */
  private async recordFixSummary(issueNumber: number, repoKey: string, result: RunResult): Promise<void> {
    // The implement session's final message IS its account of what it changed —
    // use it as the fix summary (capped). Best-effort: no summary → leave null.
    const summary = result.text?.trim();
    if (!summary) return;
    const capped = summary.length > MAX_FIX_SUMMARY_CHARS ? `${summary.slice(0, MAX_FIX_SUMMARY_CHARS)}…` : summary;
    await this.deps.state.updateRepoTask(issueNumber, repoKey, { fixSummary: capped });
  }

  /**
   * Reclaim every sub-task's worktree disk once the case is settled. Branches
   * are intentionally KEPT — each opened PR needs its head branch — so this only
   * removes the local worktrees.
   */
  private async cleanupWorktrees(issueNumber: number): Promise<void> {
    for (const task of await this.deps.state.getRepoTasks(issueNumber)) {
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
  private async finalize(issue: IssueDetail): Promise<void> {
    const tasks = await this.deps.state.getRepoTasks(issue.number);
    if (tasks.length === 0) return;

    if (tasks.some((t) => t.phase === "BLOCKED")) {
      await this.setPhase(issue.number, "BLOCKED");
      return;
    }
    if (tasks.every((t) => t.phase === "DONE")) {
      const prLines = tasks.map((t) => `- \`${t.repoKey}\`: ${t.prUrl}`).join("\n");
      const incomplete = tasks.filter((t) => t.reviewIncomplete).map((t) => t.repoKey);
      const caveat = incomplete.length
        ? `\n\n⚠️ Automated review didn't fully complete for ${incomplete.map((k) => `\`${k}\``).join(", ")} ` +
          `(reached the per-case budget). The fix and its tests passed; a maintainer should give the PR${incomplete.length > 1 ? "s" : ""} an extra look before merge.`
        : "";
      const spent = (await this.deps.state.get(issue.number))?.costUsd ?? 0;
      this.narrate(
        issue.number,
        `Done — all ${tasks.length} PR(s) opened, closing as resolved. Case cost: $${spent.toFixed(2)}${incomplete.length ? ` (review incomplete: ${incomplete.join(", ")})` : ""}.`,
      );
      this.deps.github.closeResolved(
        issue.number,
        `🤖 Fixed${incomplete.length ? "" : " and reviewed"}. Pull request(s):\n${prLines}${caveat}`,
      );
      // Roll the per-repo fix summaries up to a case-level solution description
      // for the dashboard's resolved view.
      await this.setPhase(issue.number, "DONE", { solutionSummary: this.aggregateSolution(tasks) });
      await this.cleanupWorktrees(issue.number);
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
    await this.needsHumanCase(
      issue,
      `This case spans multiple repos and not all could be completed autonomously:\n${lines}`,
    );
    await this.cleanupWorktrees(issue.number);
  }

  /**
   * Combine the per-repo fix summaries into one case-level solution description
   * for "Hur det löstes". Never null: if no per-repo summary was captured (e.g. a
   * recovered case whose PR predates this journal, so no implement session ran),
   * fall back to a factual account of what shipped so the field is always
   * populated.
   */
  private aggregateSolution(tasks: RepoTaskRow[]): string {
    const parts = tasks
      .filter((t) => t.fixSummary)
      .map((t) => (tasks.length > 1 ? `**${t.repoKey}**: ${t.fixSummary}` : t.fixSummary!));
    if (parts.length) return parts.join("\n\n");
    const repos = tasks.map((t) => t.repoKey).join(", ");
    const prCount = tasks.filter((t) => t.prUrl).length;
    return (
      `Fixed in ${repos}. The change was delivered in ${prCount} pull request${prCount === 1 ? "" : "s"} ` +
      `for a person to review and release.`
    );
  }

  /**
   * Post a portal-authored `planOnly` case's plan and park the whole case for
   * human review. The plan is the per-repo triage scopes, rendered as a
   * checklist. The case goes BLOCKED with the plan comment as its resume anchor
   * (`needsHumanCommentId`); a human reply on the issue approves it (see
   * `resumeIfReplied`). Unlike a repo-sub-task block there is no Agent SDK
   * session to resume — approval simply lets the existing BRANCH tasks proceed
   * into implementation.
   */
  private async postPlanForReview(issue: IssueDetail): Promise<void> {
    const tasks = await this.deps.state.getRepoTasks(issue.number);
    const planLines = tasks.length
      ? tasks.map((t) => `- **${t.repoKey}** — ${t.scope ?? "(scope to be detailed during implementation)"}`)
      : ["- (no repositories identified during triage)"];
    const body =
      "### Proposed plan (awaiting review)\n\n" +
      "This case was filed **plan-first** from the installer portal, so I've stopped " +
      "after triage to let a maintainer review the plan before I write any code:\n\n" +
      planLines.join("\n") +
      "\n\n**Reply on this issue to approve** — I'll then implement the plan across the " +
      "repos above. Reply with changes instead to adjust the scope. I'm parked until a " +
      "maintainer replies here.";
    this.deps.github.comment(issue.number, body);
    const anchor = this.deps.github.lastCommentId(issue.number) ?? null;
    await this.setPhase(issue.number, "BLOCKED", { needsHumanCommentId: anchor });
    this.narrate(issue.number, "Plan-first case — posted the plan and parked for review.");
  }

  /** Continue parked sub-tasks once a human has replied to their question(s). */
  async resumeIfReplied(issue: IssueDetail, row: CaseRow): Promise<void> {
    const repoTasks = await this.deps.state.getRepoTasks(issue.number);

    // Plan-first review gate: the whole case is parked awaiting plan approval —
    // no repo sub-task is BLOCKED (they're all still BRANCH), the case carries
    // `planOnly`, and the plan comment is its resume anchor. A human reply after
    // that comment approves the plan; we then drop to WORKING and let the normal
    // implement loop drive the BRANCH tasks. (The portal's own resume-comment is
    // bot-authored and deliberately does NOT count — approval must be a human.)
    if (
      row.planOnly &&
      row.phase === "BLOCKED" &&
      row.needsHumanCommentId &&
      !repoTasks.some((t) => t.phase === "BLOCKED")
    ) {
      const reply = this.deps.github.humanReplyAfter(issue.number, row.needsHumanCommentId);
      if (!reply) return; // still awaiting approval
      this.narrate(issue.number, "Plan approved by a maintainer — starting implementation…");
      await this.setPhase(issue.number, "WORKING", { needsHumanCommentId: null });
      await this.processCase(issue, (await this.deps.state.get(issue.number))!);
      return;
    }

    const blocked = repoTasks.filter((t) => t.phase === "BLOCKED");
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

      const budget = await this.budgetRemaining(issue.number);
      if (budget < MIN_SESSION_BUDGET_USD) {
        await this.outOfBudgetRepo(issue, task, "the resumed session");
        resumedAny = true;
        continue;
      }
      const result = await this.deps.runner.run({
        label: `resume #${issue.number} (${task.repoKey})`,
        cwd: worktree,
        resume: task.sessionId,
        prompt: resumeWithAnswerPrompt(reply.body, base),
        enableAskHuman: true,
        maxTurns: this.deps.config.maxImplementTurns,
        maxBudgetUsd: budget,
      });
      await this.charge(issue.number, task.repoKey, result.costUsd, `resume (${task.repoKey})`);
      if (result.blocked) {
        await this.parkRepo(issue, task, task.resumePhase, result);
        continue;
      }
      if (result.limitHit) {
        await this.outOfBudgetRepo(issue, task, "the resumed session");
        resumedAny = true;
        continue;
      }
      if (result.isError) {
        await this.needsHumanRepo(issue, task, "The resumed session errored out.");
        resumedAny = true;
        continue;
      }
      // Resumed work done; re-enter this repo at the next phase.
      const nextPhase: RepoPhase = task.resumePhase === "IMPLEMENT" ? "TEST" : "REVIEW";
      await this.setRepoPhase(issue.number, task.repoKey, nextPhase, { blockedCommentId: null });
      resumedAny = true;
    }

    if (resumedAny) {
      await this.setPhase(issue.number, "WORKING");
      await this.processCase(issue, (await this.deps.state.get(issue.number))!);
    }
  }

  /**
   * Post-completion PR feedback loop. For a DONE case, watch each opened PR for a
   * maintainer comment that @-mentions the bot (top-level or inline) and, when one
   * appears, reopen a session on the PR branch to make the requested change and
   * push it. The support issue stays CLOSED — this is a developer-side refinement,
   * not a re-investigation, so the customer is not re-notified.
   *
   * Idempotency mirrors `/retry`: the bot 👀-reacts to a comment when it acts, and
   * skips comments it has already reacted to. We react FIRST (before the work), so
   * a crash mid-session needs a human rather than re-spending budget and
   * re-pushing every tick.
   */
  async addressPrFeedbackForCase(issue: IssueDetail): Promise<void> {
    const watchable = (await this.deps.state.getRepoTasks(issue.number)).filter(
      (t) => t.phase === "DONE" && t.prUrl && !t.prWatchClosed,
    );
    for (const task of watchable) {
      try {
        await this.addressPrFeedbackForRepo(issue, task);
      } catch (e) {
        if (e instanceof ShutdownError) throw e;
        // A PR-feedback failure must never sink the worker or the case — it's
        // already resolved. Log and carry on; the comment stays un-reacted only
        // if we failed before reacting, so it'll be retried next tick.
        console.error(`[pr-feedback] #${issue.number} (${task.repoKey}) failed:`, e);
      }
    }
  }

  /** Handle one PR's outstanding maintainer @-mentions. */
  private async addressPrFeedbackForRepo(issue: IssueDetail, task: RepoTaskRow): Promise<void> {
    const repo = findRepo(this.deps.config.reposDir, task.repoKey);
    if (!repo || !task.prUrl || !task.branch) return;
    const slug = repoSlug(repo);
    if (!slug) return;
    const prNumber = parsePrNumber(task.prUrl);

    const { state, comments } = this.deps.github.prFeedback(slug, prNumber);

    // Outstanding = mentions the bot, from an authorized maintainer on THIS code
    // repo, that we haven't already reacted to.
    const outstanding = feedbackForBot(comments, this.deps.config.botLogin).filter(
      (c) =>
        c.id &&
        this.deps.github.isAuthorizedMaintainer(c.author, slug) &&
        !this.deps.github.hasBotReacted(c.id),
    );

    // A merged/closed PR can no longer be amended — tell the maintainer (once) and
    // stop watching this PR for good.
    if (state !== "open") {
      if (outstanding.length > 0) {
        for (const c of outstanding) this.deps.github.acknowledgeCommand(c.id);
        this.deps.github.replyOnPr(
          slug,
          prNumber,
          "🤖 I can't amend this PR because it's already " +
            `${state}. Please open a new support issue for any further change.`,
        );
      }
      await this.setRepoPhase(issue.number, task.repoKey, task.phase, { prWatchClosed: true });
      return;
    }

    if (outstanding.length === 0) {
      // Self-heal: if a *crashed* prior feedback round left this resolved case's
      // issue reopened + active (the finally below never ran), restore it to
      // resolved now. Scoped to our own signature — open AND `in-progress` — so a
      // maintainer's deliberate manual reopen isn't fought.
      if (issue.state === "open" && issue.labels.includes(LABEL_IN_PROGRESS)) {
        this.deps.github.closeCompletedQuiet(issue.number);
        this.narrate(issue.number, `Restored resolved status after an interrupted PR-feedback round.`);
      }
      return;
    }

    this.narrate(
      issue.number,
      `PR feedback on "${task.repoKey}" (${task.prUrl}): addressing ${outstanding.length} maintainer comment(s).`,
    );
    // React FIRST so the same comments are never acted on twice.
    for (const c of outstanding) this.deps.github.acknowledgeCommand(c.id);

    // Surface the follow-up to the customer: the case is resolved (issue closed),
    // so reopen it + mark active — `deriveStatus` on central then reports
    // `in_progress` (→ *Under utredning*) and pushes the reporter, so the app shows
    // the case working again while we address the feedback. Deliberately customer-
    // visible (a product choice); the `finally` below restores resolved/"Klar" when
    // the round ends, whatever its outcome. Idempotent if already open+active.
    this.deps.github.reopenIssue(issue.number);
    this.deps.github.addLabel(issue.number, LABEL_IN_PROGRESS);
    this.narrate(issue.number, `Reopened + marked active while addressing PR feedback on "${task.repoKey}".`);

    try {
      // A follow-up is an explicit maintainer request — give it a fresh budget
      // envelope, exactly like /retry (lifetime cost is preserved by addCost).
      await this.deps.state.update(issue.number, { costUsd: 0 });

      const base = defaultBranch(repo);
      const scope = await this.scopeFor(issue.number, task);
      // Reopen the PR branch at its remote tip (the worktree was reclaimed on close).
      const worktree = syncWorktreeToRemoteBranch(repo, task.branch);

      let attempts = 0;
      let pushed = false;
      let lastSummary = "";
      while (attempts < this.deps.config.maxTestAttempts) {
        attempts++;
        const budget = await this.budgetRemaining(issue.number);
        if (budget < MIN_SESSION_BUDGET_USD) {
          this.deps.github.replyOnPr(
            slug,
            prNumber,
            `🤖 I started on this feedback but hit the $${this.deps.config.maxBudgetPerCaseUsd.toFixed(0)} ` +
              "per-case budget before finishing. Leaving it for a maintainer.",
          );
          break;
        }
        const result = await addressPrFeedback(
          this.deps.runner,
          this.deps.config,
          issue,
          worktree,
          budget,
          outstanding,
          base,
          scope,
        );
        await this.charge(issue.number, task.repoKey, result.costUsd, `pr-feedback (${task.repoKey})`);
        if (result.limitHit || result.isError) {
          this.deps.github.replyOnPr(
            slug,
            prNumber,
            "🤖 I couldn't complete this feedback automatically " +
              `(${result.limitHit ? "ran out of budget" : "the session errored"}). Leaving it for a maintainer.`,
          );
          break;
        }
        lastSummary = result.text.trim();

        const verdict = await verifyTests(this.deps.runner, worktree, await this.budgetRemaining(issue.number));
        await this.charge(issue.number, task.repoKey, verdict.costUsd, `pr-feedback-test (${task.repoKey})`);
        if (verdict.passed) {
          pushBranch(this.deps.config, worktree, task.branch);
          pushed = true;
          break;
        }
        this.narrate(
          issue.number,
          `PR-feedback tests for "${task.repoKey}" failed (attempt ${attempts}/${this.deps.config.maxTestAttempts}): ${verdict.summary}`,
        );
        if (verdict.limitHit) {
          this.deps.github.replyOnPr(
            slug,
            prNumber,
            "🤖 I made the change but couldn't confirm the tests within budget. Leaving it for a maintainer.",
          );
          break;
        }
      }

      if (pushed) {
        this.deps.github.replyOnPr(
          slug,
          prNumber,
          `🤖 Done — pushed an update to this PR addressing the feedback.${lastSummary ? `\n\n${lastSummary}` : ""}`,
        );
        this.narrate(issue.number, `PR feedback on "${task.repoKey}" addressed and pushed.`);
      } else if (attempts >= this.deps.config.maxTestAttempts) {
        this.deps.github.replyOnPr(
          slug,
          prNumber,
          `🤖 I attempted the requested change but couldn't get the tests passing after ` +
            `${attempts} attempts. Leaving it for a maintainer.`,
        );
      }

      // Reclaim the worktree disk; the branch (and PR) live on.
      removeWorktree(repo, task.branch);
    } finally {
      // Restore the resolved ("Klar") status once the round ends — whether it
      // shipped, gave up to a maintainer, or threw. The case row stays DONE
      // throughout (we only touched GitHub state), so the PR stays watched.
      this.deps.github.closeCompletedQuiet(issue.number);
      this.narrate(issue.number, `Restored resolved status for #${issue.number} after PR feedback.`);
    }
  }
}
