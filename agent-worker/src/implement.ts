import { z } from "zod";
import type { ClaudeRunner, RunResult } from "./claude.js";
import type { Config } from "./config.js";
import type { IssueDetail } from "./github.js";
import {
  implementSystemPrompt,
  implementPrompt,
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
}

const VERIFY_MAX_TURNS = 12;

export async function implement(
  runner: ClaudeRunner,
  config: Config,
  issue: IssueDetail,
  worktreePath: string,
  scope?: RepoScope,
): Promise<RunResult> {
  return runner.run({
    label: `implement #${issue.number}${scope ? ` (${scope.repoKey})` : ""}`,
    cwd: worktreePath,
    systemPrompt: implementSystemPrompt(issue, scope),
    prompt: implementPrompt(),
    maxTurns: config.maxImplementTurns,
    enableAskHuman: true,
  });
}

export async function verifyTests(
  runner: ClaudeRunner,
  worktreePath: string,
): Promise<VerifyResult> {
  const result = await runner.run({
    cwd: worktreePath,
    systemPrompt: verifyTestsSystemPrompt(),
    prompt: verifyTestsPrompt(),
    maxTurns: VERIFY_MAX_TURNS,
    outputSchema: z.toJSONSchema(VerifySchema) as Record<string, unknown>,
  });

  if (result.isError) {
    return { passed: false, summary: "Test-verification session errored." };
  }
  const parsed = VerifySchema.safeParse(result.structuredOutput);
  if (!parsed.success) {
    return { passed: false, summary: "Test-verification returned malformed output." };
  }
  return parsed.data;
}
