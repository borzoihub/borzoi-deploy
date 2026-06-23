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

const REVIEW_MAX_TURNS = 20;

export function isBlocking(finding: Finding): boolean {
  return finding.severity === "Critical" || finding.severity === "Important";
}

/** Run one review pass; returns all findings (callers filter for blocking). */
export async function review(
  runner: ClaudeRunner,
  worktreePath: string,
  base: string,
): Promise<Finding[]> {
  const result = await runner.run({
    cwd: worktreePath,
    systemPrompt: reviewSystemPrompt(),
    prompt: reviewPrompt(base),
    maxTurns: REVIEW_MAX_TURNS,
    outputSchema: z.toJSONSchema(ReviewSchema) as Record<string, unknown>,
  });

  if (result.isError) {
    throw new Error("Review session failed");
  }
  const parsed = ReviewSchema.safeParse(result.structuredOutput);
  if (!parsed.success) {
    throw new Error(`Review returned malformed output: ${parsed.error.message}`);
  }
  return parsed.data.findings;
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
  scope?: RepoScope,
): Promise<RunResult> {
  return runner.run({
    label: `review-fix #${issue.number}${scope ? ` (${scope.repoKey})` : ""}`,
    cwd: worktreePath,
    systemPrompt: reviewFixSystemPrompt(issue, scope),
    prompt: reviewFixPrompt(formatFindings(findings)),
    maxTurns: config.maxImplementTurns,
    enableAskHuman: true,
  });
}
