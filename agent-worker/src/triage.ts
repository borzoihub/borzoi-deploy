import { z } from "zod";
import type { ClaudeRunner } from "./claude.js";
import type { IssueDetail } from "./github.js";
import { triageSystemPrompt, triagePrompt } from "./prompts.js";

/**
 * One repo the fix needs to touch, with the scope of work specific to it.
 * A single support case can span several repos (e.g. a shared `*-common` model
 * change plus the backend and frontend that consume it), each becoming its own
 * branch + pull request.
 */
const RepoTargetSchema = z.object({
  repoKey: z.string(),
  scope: z.string(),
});

/**
 * How the change is classified, which drives the branch prefix:
 *  - `bugfix`      → a verified real defect that needs fixing (`bugfix/…`)
 *  - `feature`     → genuinely new functionality (`features/…`)
 *  - `improvement` → not a defect, but a betterment over how it works today
 *                    (`improvements/…`)
 */
export const CHANGE_KINDS = ["bugfix", "feature", "improvement"] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

const TriageSchema = z.object({
  fixable: z.boolean(),
  repos: z.array(RepoTargetSchema),
  reason: z.string(),
  changeKind: z.enum(CHANGE_KINDS),
  branchSlug: z.string(),
});

export interface RepoTarget {
  repoKey: string;
  scope: string;
}

export interface TriageResult {
  fixable: boolean;
  /** Every repo the fix must touch, validated against what's available. */
  repos: RepoTarget[];
  /** Change classification, driving the branch prefix (bugfix/features/improvements). */
  changeKind: ChangeKind;
  /**
   * Short English kebab-case slug describing the fix, for the branch name
   * (`<prefix>/<issue#>-<branchSlug>`). Always English regardless of the report's
   * language; carries no installation name (that's recoverable from the issue #).
   */
  branchSlug: string;
  /**
   * Repos triage named that are NOT yet cloned in REPOS_DIR, with the scope it
   * intended for each — so when the repo later appears, the fix has context.
   */
  missingRepos: RepoTarget[];
  reason: string;
  /** Notional USD this triage session cost (added to the case envelope). */
  costUsd: number;
  /** Triage was cut off by the budget/turn ceiling — the verdict is unreliable. */
  limitHit: boolean;
}

// Triage may read across several repos to spot cross-repo (`*-common`) work, so
// it needs more turns than a single-file glance. This is only a secondary
// backstop now — the per-case USD budget is the primary guard — so keep it
// generous enough that the budget binds first.
const TRIAGE_MAX_TURNS = 40;

/**
 * Decide whether a support case should be fixed in code and, if so, in which
 * repos. Read-only: the session reasons over the issue and the available repos
 * (including how they depend on each other via shared `*-common` packages) and
 * returns a structured verdict listing every repo that needs a change.
 */
export async function triage(
  runner: ClaudeRunner,
  reposDir: string,
  availableRepoKeys: string[],
  issue: IssueDetail,
  budgetUsd: number,
  maintainerOverride?: string,
): Promise<TriageResult> {
  console.log(
    `[triage] #${issue.number}: available repos = [${availableRepoKeys.join(", ") || "none"}]` +
      (maintainerOverride ? " (maintainer override in effect)" : ""),
  );
  const result = await runner.run({
    label: `triage #${issue.number}`,
    cwd: reposDir,
    systemPrompt: triageSystemPrompt(availableRepoKeys, maintainerOverride),
    prompt: triagePrompt(issue),
    maxTurns: TRIAGE_MAX_TURNS,
    maxBudgetUsd: budgetUsd,
    dataQuery: { issueNumber: issue.number },
    outputSchema: z.toJSONSchema(TriageSchema) as Record<string, unknown>,
  });

  // Budget/turn ceiling: the verdict can't be trusted (often no structured
  // output at all). Surface it so the case hard-fails to needs-human, not a
  // bogus won't-fix close.
  if (result.limitHit) {
    return {
      fixable: false,
      repos: [],
      missingRepos: [],
      // Defaults are inert here: a limit-hit triage hard-fails to needs-human and
      // never reaches branch creation, so changeKind/branchSlug are unused.
      changeKind: "bugfix",
      branchSlug: "fix",
      reason: "Triage was cut off by the budget/turn ceiling before reaching a verdict.",
      costUsd: result.costUsd,
      limitHit: true,
    };
  }

  if (result.isError) {
    throw new Error(`Triage session failed for issue #${issue.number}`);
  }

  const parsed = TriageSchema.safeParse(result.structuredOutput);
  if (!parsed.success) {
    throw new Error(
      `Triage returned malformed output for #${issue.number}: ${parsed.error.message}`,
    );
  }

  // Split named repos into present (workable) and missing (not cloned). Dedupe
  // by repoKey, keeping the first scope, and never trust a repo not present.
  const available = new Set(availableRepoKeys);
  const seen = new Set<string>();
  const repos: RepoTarget[] = [];
  const missingRepos: RepoTarget[] = [];
  for (const t of parsed.data.repos) {
    if (seen.has(t.repoKey)) continue;
    seen.add(t.repoKey);
    if (available.has(t.repoKey)) {
      repos.push({ repoKey: t.repoKey, scope: t.scope });
    } else {
      missingRepos.push({ repoKey: t.repoKey, scope: t.scope });
    }
  }

  return {
    fixable: parsed.data.fixable,
    repos,
    missingRepos,
    changeKind: parsed.data.changeKind,
    branchSlug: parsed.data.branchSlug,
    reason: parsed.data.reason,
    costUsd: result.costUsd,
    limitHit: false,
  };
}
