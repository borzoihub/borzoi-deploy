import { z } from "zod";
import type { ClaudeRunner, RunResult } from "./claude.js";
import type { IssueDetail, PrComment } from "./github.js";
import {
  implementSystemPrompt,
  implementPrompt,
  prFeedbackSystemPrompt,
  prFeedbackPrompt,
  verifyTestsSystemPrompt,
  verifyTestsPrompt,
  type RepoScope,
} from "./prompts.js";

/**
 * The IMPLEMENT and TEST phases.
 *
 * `implement` runs an autonomous coding session in the worktree that fixes the
 * bug, writes tests, runs them, and commits. It may park on ask_human.
 *
 * `verifyTests` is an independent trust-but-verify gate: a read-only session
 * that works out how the repo runs its tests, runs them, and reports pass/fail.
 * It is repo-agnostic (no hard-coded test command).
 */

const VerifySchema = z.object({
  passed: z.boolean(),
  summary: z.string(),
});

export interface VerifyResult {
  passed: boolean;
  summary: string;
  /** Notional USD this verify session cost (added to the case envelope). */
  costUsd: number;
  /** Verification was cut off by the per-case budget ceiling before reaching a verdict. */
  limitHit: boolean;
}

export async function implement(
  runner: ClaudeRunner,
  issue: IssueDetail,
  worktreePath: string,
  budgetUsd: number,
  scope?: RepoScope,
  priorWork?: string,
  base = "main",
): Promise<RunResult> {
  return runner.run({
    label: `implement #${issue.number}${scope ? ` (${scope.repoKey})` : ""}`,
    cwd: worktreePath,
    systemPrompt: implementSystemPrompt(issue, scope, priorWork, base),
    prompt: implementPrompt(),
    maxBudgetUsd: budgetUsd,
    enableAskHuman: true,
    dataQuery: { issueNumber: issue.number },
  });
}

/**
 * Address maintainer feedback on an already-open PR, inside a worktree synced to
 * the PR's branch. Mirrors `implement` but for a post-completion follow-up: it
 * first merges the default branch (`base`) into the PR branch and resolves any
 * conflicts so the PR isn't left behind main, then makes the smallest change
 * satisfying the feedback, updates tests, and commits. `ask_human` is
 * intentionally DISABLED — there is no open issue thread to park a question on,
 * and the maintainer reviewing the PR is the human in the loop.
 */
export async function addressPrFeedback(
  runner: ClaudeRunner,
  issue: IssueDetail,
  worktreePath: string,
  budgetUsd: number,
  feedback: PrComment[],
  base: string,
  scope?: RepoScope,
): Promise<RunResult> {
  return runner.run({
    label: `pr-feedback #${issue.number}${scope ? ` (${scope.repoKey})` : ""}`,
    cwd: worktreePath,
    systemPrompt: prFeedbackSystemPrompt(issue, scope, feedback, base),
    prompt: prFeedbackPrompt(),
    maxBudgetUsd: budgetUsd,
    enableAskHuman: false,
  });
}

export async function verifyTests(
  runner: ClaudeRunner,
  worktreePath: string,
  budgetUsd: number,
): Promise<VerifyResult> {
  const result = await runner.run({
    cwd: worktreePath,
    systemPrompt: verifyTestsSystemPrompt(),
    prompt: verifyTestsPrompt(),
    maxBudgetUsd: budgetUsd,
    outputSchema: z.toJSONSchema(VerifySchema) as Record<string, unknown>,
  });

  if (result.limitHit) {
    return {
      passed: false,
      summary: "Test-verification was cut off by the per-case budget ceiling.",
      costUsd: result.costUsd,
      limitHit: true,
    };
  }
  if (result.isError) {
    return { passed: false, summary: "Test-verification session errored.", costUsd: result.costUsd, limitHit: false };
  }
  const parsed = VerifySchema.safeParse(result.structuredOutput);
  if (!parsed.success) {
    return {
      passed: false,
      summary: "Test-verification returned malformed output.",
      costUsd: result.costUsd,
      limitHit: false,
    };
  }
  return { ...parsed.data, costUsd: result.costUsd, limitHit: false };
}
