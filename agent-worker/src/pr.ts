import { execFileSync } from "node:child_process";
import type { Config } from "./config.js";
import type { IssueDetail } from "./github.js";
import type { RepoScope } from "./prompts.js";

/**
 * The PR phase — push the branch and open a pull request against the repo's
 * default branch. `gh auth setup-git` (run once at startup) lets `git push`
 * authenticate over HTTPS with GH_TOKEN; `gh pr create` infers the repo from
 * the worktree's origin.
 */

export interface PrResult {
  url: string;
}

function run(cmd: string, args: string[], cwd: string, config: Config): string {
  return execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GH_TOKEN: config.ghToken },
    maxBuffer: 8 * 1024 * 1024,
  }).trim();
}

export function openPr(
  config: Config,
  worktreePath: string,
  branch: string,
  base: string,
  issue: IssueDetail,
  scope?: RepoScope,
): PrResult {
  const title = `Fix: ${issue.title} (#${issue.number})`;
  // Multi-repo cases close the issue only when every repo's PR is open, so a
  // single repo's PR must not auto-close the issue — use "Part of" not "Fixes".
  const multiRepo = scope !== undefined && scope.siblingRepoKeys.length > 0;
  const body = [
    multiRepo ? `Part of the fix for #${issue.number}.` : `Fixes #${issue.number}.`,
    ...(scope
      ? [
          "",
          `Repo: \`${scope.repoKey}\`. Scope: ${scope.scope}`,
          ...(multiRepo
            ? [`Companion changes in: ${scope.siblingRepoKeys.map((r) => `\`${r}\``).join(", ")}.`]
            : []),
        ]
      : []),
    "",
    "Automated fix produced by the Voltini support-case resolver, reviewed",
    "from the architect/performance/energy-domain/tester/security perspectives",
    "with the test suite passing.",
  ].join("\n");

  if (config.dryRun) {
    console.log(`[dry-run] git push -u origin ${branch} (in ${worktreePath})`);
    console.log(`[dry-run] gh pr create --base ${base} --head ${branch} --title "${title}"`);
    return { url: "(dry-run: no PR created)" };
  }

  run("git", ["push", "-u", "origin", branch], worktreePath, config);
  const url = run(
    "gh",
    ["pr", "create", "--base", base, "--head", branch, "--title", title, "--body", body],
    worktreePath,
    config,
  );
  return { url };
}
