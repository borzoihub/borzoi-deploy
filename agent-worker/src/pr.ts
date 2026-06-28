import { execFileSync } from "node:child_process";
import type { Config } from "./config.js";
import type { IssueDetail } from "./github.js";
import type { RepoScope } from "./prompts.js";
import { repoSlug, type Repo } from "./repos.js";

/**
 * The PR phase — push the branch and open a pull request against the repo's
 * default branch. `gh auth setup-git` (run once at startup) lets `git push`
 * authenticate over HTTPS with GH_TOKEN; `gh pr create` infers the repo from
 * the worktree's origin.
 */

export interface PrResult {
  url: string;
}

export interface ExistingPr {
  url: string;
  /** "open" | "merged" | "closed" (lowercased gh state). */
  state: string;
}

/**
 * Look for a pull request already opened from `branch` on the repo's GitHub
 * remote — the signal that this issue's work was (at least partly) done before,
 * even if our local journal was wiped. Read-only.
 */
export function findExistingPr(config: Config, repo: Repo, branch: string): ExistingPr | undefined {
  const slug = repoSlug(repo);
  if (!slug) return undefined;
  try {
    const out = run(
      "gh",
      ["pr", "list", "-R", slug, "--head", branch, "--state", "all", "--json", "url,state", "--limit", "1"],
      repo.path,
      config,
    );
    const arr = JSON.parse(out) as Array<{ url: string; state: string }>;
    const first = arr[0];
    if (first) return { url: first.url, state: String(first.state).toLowerCase() };
  } catch {
    // The token may not have access to the code repo (read-only probe). Don't
    // leak gh's raw stderr — say clearly what happened and carry on.
    console.log(
      `[recover] Couldn't query ${slug} for an existing PR (no gh access to that repo?) — ` +
        `skipping PR-based recovery. NOTE: pushing/opening a PR there will also fail until the token has access.`,
    );
  }
  return undefined;
}

function run(cmd: string, args: string[], cwd: string, config: Config): string {
  return execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GH_TOKEN: config.ghToken },
    maxBuffer: 8 * 1024 * 1024,
    // Capture stderr instead of letting it inherit to our console — a handled
    // probe failure (e.g. the PR lookup below) shouldn't print a scary raw
    // "GraphQL: Could not resolve…" line; the caller decides what to log.
    stdio: ["ignore", "pipe", "pipe"],
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

  run("git", ["push", "-u", "origin", branch], worktreePath, config);
  const url = run(
    "gh",
    ["pr", "create", "--base", base, "--head", branch, "--title", title, "--body", body],
    worktreePath,
    config,
  );
  return { url };
}
