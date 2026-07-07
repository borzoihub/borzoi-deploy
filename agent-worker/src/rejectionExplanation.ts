import { z } from "zod";
import type { ClaudeRunner } from "./claude.js";
import type { IssueDetail } from "./github.js";
import { rejectionExplanationSystemPrompt, rejectionExplanationPrompt } from "./prompts.js";

/**
 * Generic, always-safe fallback shown to the homeowner when the dedicated pass
 * can't produce a sanitised explanation (session error, or cut off by the
 * budget ceiling). We deliberately fall back to THIS rather than the raw
 * internal triage `reason` — the whole point of the pass is that the internal
 * rationale must never reach the customer unfiltered.
 */
export const SAFE_REJECTION_FALLBACK =
  "After reviewing your report we determined this does not require a change to Voltini, so the case " +
  "has been closed. If you believe this needs another look, reply to your case and we'll take another look.";

const ExplanationSchema = z.object({ explanation: z.string() });

export interface RejectionExplanationResult {
  /** Homeowner-safe explanation for why the case was declined. */
  explanation: string;
  /** Notional USD this session cost (added to the case envelope). */
  costUsd: number;
}

/**
 * Rewrite triage's internal rejection rationale into a short, honest,
 * non-technical explanation that is safe to show the homeowner verbatim as "why
 * your case was declined". Runs with no repo/data tools and relies solely on the
 * text passed in. On any failure (session error, malformed output, or a
 * budget cutoff) it returns {@link SAFE_REJECTION_FALLBACK} rather than
 * leaking the raw internal reason — the caller still gets a usable, safe string.
 */
export async function explainRejection(
  runner: ClaudeRunner,
  reposDir: string,
  issue: IssueDetail,
  internalReason: string,
  budgetUsd: number,
): Promise<RejectionExplanationResult> {
  const result = await runner.run({
    label: `reject-explain #${issue.number}`,
    cwd: reposDir,
    systemPrompt: rejectionExplanationSystemPrompt(),
    prompt: rejectionExplanationPrompt(issue, internalReason),
    maxBudgetUsd: budgetUsd,
    outputSchema: z.toJSONSchema(ExplanationSchema) as Record<string, unknown>,
  });

  if (result.limitHit || result.isError) {
    console.warn(
      `[reject-explain] #${issue.number}: ${result.limitHit ? "budget cutoff" : "session error"} — ` +
        "using safe fallback explanation.",
    );
    return { explanation: SAFE_REJECTION_FALLBACK, costUsd: result.costUsd };
  }

  const parsed = ExplanationSchema.safeParse(result.structuredOutput);
  const explanation = parsed.success ? parsed.data.explanation.trim() : "";
  if (!explanation) {
    console.warn(
      `[reject-explain] #${issue.number}: malformed/empty output — using safe fallback explanation.`,
    );
    return { explanation: SAFE_REJECTION_FALLBACK, costUsd: result.costUsd };
  }

  return { explanation, costUsd: result.costUsd };
}
