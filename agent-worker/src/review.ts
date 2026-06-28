import { z } from "zod";
import type { ClaudeRunner, RunResult } from "./claude.js";
import type { Config } from "./config.js";
import type { IssueDetail } from "./github.js";
import {
  reviewSystemPrompt,
  reviewPrompt,
  reviewFixSystemPrompt,
  reviewFixPrompt,
  type RepoScope,
} from "./prompts.js";

/**
 * The REVIEW phase — an adaptation of the `!perfect-review` command.
 *
 * One review session inspects the branch diff from all five expert perspectives
 * (Architect, DB/Perf, Energy-domain, Tester, Security) and returns structured
 * findings. We act only on blocking severities (Critical/Important); Minor
 * findings are logged, never block — they are the nitpicks we deliberately skip.
 *
 * The fix→re-review loop lives in pipeline.ts so it can interleave with the
 * test gate and persist progress between iterations.
 */

export const SEVERITIES = ["Critical", "Important", "Minor"] as const;
export type Severity = (typeof SEVERITIES)[number];

const FindingSchema = z.object({
  severity: z.enum(SEVERITIES),
  file: z.string(),
  title: z.string(),
  detail: z.string(),
});
const ReviewSchema = z.object({
  findings: z.array(FindingSchema),
});

export type Finding = z.infer<typeof FindingSchema>;

export interface ReviewResult {
  findings: Finding[];
  /** Notional USD this review session cost (added to the case envelope). */
  costUsd: number;
  /**
   * The review read-pass was cut off by the budget/turn ceiling before it could
   * emit findings. The read-pass is advisory, so callers SOFT-fail this (ship the
   * already-tested work, annotate the close) rather than handing off to a human.
   */
  limitHit: boolean;
}

// Only a secondary backstop now — the per-case USD budget is the primary guard.
// Generous so a large diff (e.g. the mobile app) can be read across all five
// perspectives without the turn cap cutting the read-pass short.
const REVIEW_MAX_TURNS = 60;

export function isBlocking(finding: Finding): boolean {
  return finding.severity === "Critical" || finding.severity === "Important";
}

/** Run one review pass; returns all findings (callers filter for blocking). */
export async function review(
  runner: ClaudeRunner,
  worktreePath: string,
  base: string,
  budgetUsd: number,
): Promise<ReviewResult> {
  const result = await runner.run({
    cwd: worktreePath,
    systemPrompt: reviewSystemPrompt(),
    prompt: reviewPrompt(base),
    maxTurns: REVIEW_MAX_TURNS,
    maxBudgetUsd: budgetUsd,
    outputSchema: z.toJSONSchema(ReviewSchema) as Record<string, unknown>,
  });

  if (result.limitHit) {
    return { findings: [], costUsd: result.costUsd, limitHit: true };
  }
  if (result.isError) {
    throw new Error("Review session failed");
  }
  const parsed = ReviewSchema.safeParse(result.structuredOutput);
  if (!parsed.success) {
    throw new Error(`Review returned malformed output: ${parsed.error.message}`);
  }
  return { findings: parsed.data.findings, costUsd: result.costUsd, limitHit: false };
}

/** Format blocking findings as a checklist for the fix session. */
export function formatFindings(findings: Finding[]): string {
  return findings
    .map(
      (f, i) =>
        `${i + 1}. [${f.severity}] ${f.file} — ${f.title}\n   ${f.detail}`,
    )
    .join("\n");
}

/** Run a session that fixes the given blocking findings and commits. */
export async function reviewFix(
  runner: ClaudeRunner,
  config: Config,
  issue: IssueDetail,
  worktreePath: string,
  findings: Finding[],
  budgetUsd: number,
  scope?: RepoScope,
): Promise<RunResult> {
  return runner.run({
    label: `review-fix #${issue.number}${scope ? ` (${scope.repoKey})` : ""}`,
    cwd: worktreePath,
    systemPrompt: reviewFixSystemPrompt(issue, scope),
    prompt: reviewFixPrompt(formatFindings(findings)),
    maxTurns: config.maxImplementTurns,
    maxBudgetUsd: budgetUsd,
    enableAskHuman: true,
  });
}
