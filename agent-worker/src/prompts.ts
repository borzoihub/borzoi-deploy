import type { IssueDetail } from "./github.js";

/**
 * Prompt builders for the agent sessions. Kept together so the wording the bot
 * uses against customer-facing work is reviewable in one place.
 *
 * House rule echoed into every session: the bot is autonomous and must not ask
 * a human unless genuinely blocked (it has the ask_human tool for that).
 */

function issueContext(issue: IssueDetail): string {
  return [
    `Support case #${issue.number}: ${issue.title}`,
    `Labels: ${issue.labels.join(", ") || "(none)"}`,
    "",
    "--- Issue body (full bug report: transcript, installation context, reporter) ---",
    issue.body,
    "--- end issue body ---",
  ].join("\n");
}

const AUTONOMY_RULE =
  "You are operating fully autonomously on a headless machine. No human is " +
  "watching in real time. Work to completion without asking for confirmation. " +
  "Only if you are genuinely blocked on information a human alone can provide " +
  "(an ambiguous product decision, missing access) call the ask_human tool " +
  "with one specific question, then stop.";

export function triageSystemPrompt(availableRepoKeys: string[]): string {
  return [
    "You are a senior engineer triaging an incoming customer support case for the Voltini energy-management system.",
    "Decide whether the case should be fixed in code, and if so, EVERY repository the fix must touch.",
    "",
    `Repositories currently available to work on: ${availableRepoKeys.join(", ") || "(none)"}.`,
    "You may read across the available repos to understand the code before deciding.",
    "",
    "IMPORTANT — the Voltini repos are interdependent, so a single fix often spans several of them:",
    "- Shared models/types live in `*-common` packages (e.g. borzoi-common, theworks-common). Changing a shared",
    "  model usually REQUIRES matching changes in every repo that consumes it (backend, frontend), and the",
    "  consumers' tests will not pass against the old published package until those changes land too.",
    "- A behaviour that's visible in the frontend may have its root cause (and its fix) in the backend, or vice versa.",
    "List ALL repos a correct, complete fix needs — not just the most obvious one. Each becomes its own branch and PR.",
    "",
    "Classify:",
    "- fixable=true only for an actual code defect or a small, well-specified change you can implement in the available repos.",
    "- fixable=false for questions, user-error, duplicates, vague feature wishes, or anything not actionable as a code change.",
    "- repos: one entry per repository the fix must touch. For each, give `repoKey` (exactly as listed above) and a",
    "  `scope` — 1-2 sentences describing the change to make IN THAT repo. Use [] if fixable=false.",
    "  If the correct fix needs a repo that is NOT in the available list, still include it (it will be flagged for a human).",
    "Return your decision via the structured output schema. Keep `reason` to 1-3 sentences.",
  ].join("\n");
}

export function triagePrompt(issue: IssueDetail): string {
  return issueContext(issue);
}

export function implementSystemPrompt(
  issue: IssueDetail,
  scope?: RepoScope,
  priorWork?: string,
): string {
  const scopeText = scope ? scopeBlock(scope) : "";
  return [
    "You are a senior engineer fixing a customer support case for the Voltini energy-management system.",
    "You are working inside a git worktree of the target repository. Follow the repo's CLAUDE.md and CODING_STYLE.md conventions.",
    "",
    AUTONOMY_RULE,
    "",
    ...(scopeText ? [scopeText, ""] : []),
    ...(priorWork ? [priorWorkBlock(priorWork), ""] : []),
    "Your task:",
    "1. Reproduce/understand the reported problem from the issue.",
    "2. Implement a correct, minimal fix that matches the surrounding code"
    + (scopeText ? ", limited to THIS repository's scope above." : "."),
    "3. Add or update unit tests that capture the intent of the fix (see the repo's testing conventions).",
    "4. Run the repo's test suite and make it pass.",
    "5. Commit your work with a clear message referencing the issue number.",
    "Do not push or open a pull request — the orchestrator handles that.",
    "",
    issueContext(issue),
  ].join("\n");
}

/** Per-repo scope context for a case that spans multiple repos. */
export interface RepoScope {
  repoKey: string;
  scope: string;
  /** The other repos this same case is being fixed in (for context only). */
  siblingRepoKeys: string[];
}

function scopeBlock(s: RepoScope): string {
  const multi = s.siblingRepoKeys.length > 0;
  // A recovered case may have no real per-repo scope (the triage scope lives
  // only in the journal and is lost on a wipe). Don't print a misleading
  // "Scope: (recovered…)" line or a "across multiple repos" claim that isn't
  // true — fall back to the issue + the prior-work summary instead.
  const hasScope = !!s.scope && !s.scope.startsWith("(recovered:");
  if (!multi && !hasScope) return "";
  const lines: string[] = [];
  if (multi) {
    lines.push(
      `This support case is being fixed across multiple repos. You are working ONLY on **${s.repoKey}**.`,
    );
  }
  if (hasScope) lines.push(`Scope for this repo: ${s.scope}`);
  if (multi) {
    lines.push(
      `The rest of the fix is handled separately in: ${s.siblingRepoKeys.join(", ")}. ` +
        "Do NOT edit those repos here. If this repo depends on a shared `*-common` change happening in a " +
        "sibling repo, code against the agreed shape and keep this repo's change self-consistent; the " +
        "orchestrator opens one PR per repo.",
    );
  }
  return lines.join("\n");
}

function priorWorkBlock(summary: string): string {
  return [
    "A previous attempt already started this fix on the current branch (a separate session — you do not have its memory). " +
      "Review what is already here and CONTINUE from it: build on the existing commits and changes, and do not start over or revert them unless they are wrong.",
    "",
    summary,
  ].join("\n");
}

export function implementPrompt(): string {
  return "Implement the fix for this support case now, end to end. Commit when the tests pass.";
}

export function resumeWithAnswerPrompt(answer: string): string {
  return [
    "A human has replied to your question:",
    "",
    answer,
    "",
    "Continue the task with this information.",
  ].join("\n");
}

export function verifyTestsSystemPrompt(): string {
  return [
    "You are verifying that a repository's automated tests pass.",
    "Determine how this repo runs its unit tests (read package.json / its CLAUDE.md), run the full suite, and report the result.",
    "Do not modify any code. Report via the structured output schema: passed=true only if the suite ran and every test passed.",
  ].join("\n");
}

export function verifyTestsPrompt(): string {
  return "Run the repository's test suite and report whether it passes.";
}

export function reviewSystemPrompt(): string {
  return [
    "You are reviewing a code change (the current branch's diff against its base) for a Voltini support-case fix.",
    "Review from five expert perspectives and report every finding via the structured output schema:",
    "1. Architect — readability, simplicity, reuse, adherence to the repo's CLAUDE.md / CODING_STYLE.md, dead code.",
    "2. Database & performance — query efficiency, caching correctness, time-series power↔energy units, concurrency.",
    "3. Energy domain — physical correctness (kW vs kWh), battery cycle-mode semantics, LP/peak-guard correctness, edge cases (hour/day/month boundaries, zero/empty/full).",
    "4. Tester — test coverage and quality; meaningful assertions, exact values, no silent skips; missing scenarios.",
    "5. Security — injection, access control, secret exposure, input validation.",
    "",
    "Severity: Critical (must fix before merge), Important (should fix), Minor (nice to have).",
    "Be precise; only report real issues in THIS diff. If the change is clean, return an empty findings array.",
  ].join("\n");
}

export function reviewPrompt(base: string): string {
  return [
    `Review the diff of the current branch against origin/${base}.`,
    "Run `git fetch origin` first if needed, then inspect the diff and the changed files in context.",
  ].join("\n");
}

export function reviewFixSystemPrompt(issue: IssueDetail, scope?: RepoScope): string {
  return [
    "You are addressing blocking review findings on your support-case fix, inside the repo worktree.",
    "Fix every finding listed below. Keep changes minimal and consistent with the repo conventions.",
    "Update/add tests as needed, run the suite until green, and commit.",
    "",
    AUTONOMY_RULE,
    "",
    ...(scope ? [scopeBlock(scope), ""] : []),
    issueContext(issue),
  ].join("\n");
}

export function reviewFixPrompt(findings: string): string {
  return [
    "Address these blocking review findings, then re-run the tests and commit:",
    "",
    findings,
  ].join("\n");
}
