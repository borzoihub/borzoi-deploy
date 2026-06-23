import type { Config } from "./config.js";
import type { GitHub, IssueDetail } from "./github.js";
import { LABEL_IN_PROGRESS, LABEL_NEEDS_HUMAN } from "./github.js";
import type { StateStore, CaseRow, RepoTaskRow, RepoPhase } from "./state.js";
import type { ClaudeRunner, RunResult } from "./claude.js";
import {
  findRepo,
  defaultBranch,
  ensureWorktree,
  removeWorktree,
  type Repo,
} from "./repos.js";
import { triage } from "./triage.js";
import { implement, verifyTests } from "./implement.js";
import { review, reviewFix, isBlocking, formatFindings } from "./review.js";
import { openPr } from "./pr.js";
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
    this.deps.github.comment(issue.number, `🤖 ${message}`);
    this.setPhase(issue.number, "NEEDS_HUMAN", { error: message });
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

  /** Advance a case as far as possible this invocation. */
  async processCase(issue: IssueDetail, row: CaseRow): Promise<void> {
    if (row.phase === "NEW") {
      const planned = await this.triageAndPlan(issue);
      if (!planned) return; // terminal (wontfix / needs-human) already handled
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
    const { discoverRepos } = await import("./repos.js");
    const available = discoverRepos(reposDir).map((r) => r.key);
    const result = await triage(this.deps.runner, reposDir, available, issue);

    if (!result.fixable) {
      this.narrate(issue.number, `Not actionable — marking won't-fix: ${result.reason}`);
      this.deps.github.closeWontFix(issue.number, `🤖 Closing as won't-fix: ${result.reason}`);
      this.setPhase(issue.number, "WONTFIX", { error: result.reason });
      return false;
    }

    if (result.repos.length === 0) {
      // Fixable, but none of the required repos are cloned.
      this.needsHumanCase(
        issue,
        `This looks fixable but the required repo(s) aren't cloned into REPOS_DIR` +
          (result.missingRepoKeys.length ? ` (${result.missingRepoKeys.join(", ")})` : "") +
          `. ${result.reason}`,
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
    // …and a parked sub-task per required-but-missing repo, so the case can't
    // auto-resolve while part of the fix has nowhere to land.
    for (const repoKey of result.missingRepoKeys) {
      this.deps.state.ensureRepoTask(issue.number, repoKey, { scope: "(repo not cloned)", branch });
      this.setRepoPhase(issue.number, repoKey, "NEEDS_HUMAN", {
        error: "Required for the fix but not cloned into REPOS_DIR.",
      });
    }

    const repoList = result.repos.map((r) => r.repoKey).join(", ");
    const missingNote = result.missingRepoKeys.length
      ? ` (also needs, but missing: ${result.missingRepoKeys.join(", ")})`
      : "";
    this.narrate(
      issue.number,
      `Fixable — will open ${result.repos.length} PR(s) across: ${repoList}${missingNote}. Marking active.`,
    );
    this.deps.github.addLabel(issue.number, LABEL_IN_PROGRESS);
    return true;
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

    const repo = this.repoOrThrow(task.repoKey);
    const base = defaultBranch(repo);
    const branch = task.branch ?? `features/${issue.number}-${slugify(issue.title)}`;
    const scope = this.scopeFor(issue.number, task);
    let phase = task.phase;

    if (phase === "BRANCH") {
      ensureWorktree(repo, branch, base);
      this.setRepoPhase(issue.number, task.repoKey, "IMPLEMENT", { branch });
      phase = "IMPLEMENT";
    }

    const worktree = ensureWorktree(repo, branch, base);

    if (phase === "IMPLEMENT") {
      if (!this.linkProviders(issue, task, worktree)) return;
      this.narrate(issue.number, `Fixing "${task.repoKey}": ${task.scope ?? ""}`);
      const result = await implement(this.deps.runner, this.deps.config, issue, worktree, scope);
      if (result.blocked) return this.parkRepo(issue, task, "IMPLEMENT", result);
      if (result.isError) return this.needsHumanRepo(issue, task, "The implementation session errored out.");
      this.setRepoPhase(issue.number, task.repoKey, "TEST");
      phase = "TEST";
    }

    if (phase === "TEST") {
      // Re-link in case the implement session ran its own `npm install` and
      // dropped the local override — tests must see the sibling's local change.
      if (!this.linkProviders(issue, task, worktree)) return;
      this.narrate(issue.number, `Running "${task.repoKey}" test suite…`);
      const verdict = await verifyTests(this.deps.runner, worktree);
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
        this.narrate(issue.number, `Re-working "${task.repoKey}" to make tests pass…`);
        const fix = await implement(this.deps.runner, this.deps.config, issue, worktree, scope);
        if (fix.blocked) return this.parkRepo(issue, task, "IMPLEMENT", fix);
        if (fix.isError) return this.needsHumanRepo(issue, task, "The fix session errored out.");
        return this.driveRepoTask(issue, this.deps.state.getRepoTask(issue.number, task.repoKey)!);
      }
      this.setRepoPhase(issue.number, task.repoKey, "REVIEW");
      phase = "REVIEW";
    }

    if (phase === "REVIEW") {
      this.narrate(issue.number, `Self-reviewing "${task.repoKey}" (5 perspectives)…`);
      const findings = await review(this.deps.runner, worktree, base);
      const blocking = findings.filter(isBlocking);
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
        const fix = await reviewFix(this.deps.runner, this.deps.config, issue, worktree, blocking, scope);
        if (fix.blocked) return this.parkRepo(issue, task, "REVIEW", fix);
        if (fix.isError) return this.needsHumanRepo(issue, task, "The review-fix session errored out.");
        return this.driveRepoTask(issue, this.deps.state.getRepoTask(issue.number, task.repoKey)!);
      }
      this.setRepoPhase(issue.number, task.repoKey, "PR");
      phase = "PR";
    }

    if (phase === "PR") {
      this.narrate(issue.number, `Review clean — creating pull request for "${task.repoKey}"…`);
      const pr = openPr(this.deps.config, worktree, branch, base, issue, scope);
      this.setRepoPhase(issue.number, task.repoKey, "DONE", { prUrl: pr.url });
      this.narrate(issue.number, `PR opened for "${task.repoKey}": ${pr.url}`);
      // Worktree is retained until the whole case finalizes — a consumer sibling
      // may still need to build/link against this repo's local change.
    }
  }

  /** Remove every sub-task's worktree+branch once the case is fully settled. */
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
      this.narrate(issue.number, `Done — all ${tasks.length} PR(s) opened, closing as resolved.`);
      this.deps.github.closeResolved(
        issue.number,
        `🤖 Fixed and reviewed. Pull request(s):\n${prLines}`,
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

      const result = await this.deps.runner.run({
        label: `resume #${issue.number} (${task.repoKey})`,
        cwd: worktree,
        resume: task.sessionId,
        prompt: resumeWithAnswerPrompt(reply.body),
        enableAskHuman: true,
        maxTurns: this.deps.config.maxImplementTurns,
      });
      if (result.blocked) {
        this.parkRepo(issue, task, task.resumePhase, result);
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
