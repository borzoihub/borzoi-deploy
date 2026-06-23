import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Repo discovery + git worktree management.
 *
 * A human pre-clones the repos the bot may work on into REPOS_DIR. We discover
 * them by scanning for subdirectories that are git repos. We never clone:
 * if a case needs a repo that isn't present, the caller asks a human to add it.
 *
 * Each case gets an isolated worktree under <repo>/.worktrees/<branch> so the
 * main checkout is never disturbed and an abandoned case is trivial to discard.
 */

export interface Repo {
  /** Directory name under REPOS_DIR, also used as the repo key. */
  key: string;
  /** Absolute path to the main checkout. */
  path: string;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function isGitRepo(path: string): boolean {
  return existsSync(join(path, ".git"));
}

/** Discover every pre-cloned git repo in REPOS_DIR. */
export function discoverRepos(reposDir: string): Repo[] {
  if (!existsSync(reposDir)) {
    throw new Error(`REPOS_DIR does not exist: ${reposDir}`);
  }
  const repos: Repo[] = [];
  for (const name of readdirSync(reposDir)) {
    const path = join(reposDir, name);
    if (name.startsWith(".")) continue;
    let isDir = false;
    try {
      isDir = statSync(path).isDirectory();
    } catch {
      continue;
    }
    if (isDir && isGitRepo(path)) {
      repos.push({ key: name, path });
    }
  }
  return repos.sort((a, b) => a.key.localeCompare(b.key));
}

export function findRepo(reposDir: string, key: string): Repo | undefined {
  return discoverRepos(reposDir).find((r) => r.key === key);
}

/** The repo's default branch (e.g. "main"), via origin/HEAD. */
export function defaultBranch(repo: Repo): string {
  // origin/HEAD -> refs/remotes/origin/main
  try {
    const ref = git(repo.path, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
    const parts = ref.split("/");
    const branch = parts[parts.length - 1];
    if (branch) return branch;
  } catch {
    // origin/HEAD not set; fall through
  }
  // Fallback: ask the remote and cache it.
  const shown = git(repo.path, ["remote", "show", "origin"]);
  const m = shown.match(/HEAD branch:\s*(\S+)/);
  if (m && m[1]) return m[1];
  throw new Error(`Cannot determine default branch for ${repo.key}`);
}

function worktreePath(repo: Repo, branch: string): string {
  // Branch may contain "/", flatten it for the directory name.
  const safe = branch.replace(/[^a-zA-Z0-9._-]/g, "_");
  return join(repo.path, ".worktrees", safe);
}

/**
 * Create (or reuse) a worktree for `branch`, freshly based on the latest
 * default branch. Returns the worktree path. Idempotent: if the worktree
 * already exists (resume after restart), it is returned as-is.
 */
export function ensureWorktree(repo: Repo, branch: string, base: string): string {
  const path = worktreePath(repo, branch);
  if (existsSync(path)) {
    return path;
  }
  // Make sure we branch off an up-to-date base.
  git(repo.path, ["fetch", "origin", base]);
  // Create the branch + worktree off origin/<base>.
  git(repo.path, [
    "worktree",
    "add",
    "-b",
    branch,
    path,
    `origin/${base}`,
  ]);
  return path;
}

/** Remove a worktree and delete its branch (for abandoned cases). */
export function removeWorktree(repo: Repo, branch: string): void {
  const path = worktreePath(repo, branch);
  if (existsSync(path)) {
    try {
      git(repo.path, ["worktree", "remove", "--force", path]);
    } catch {
      // ignore — best effort cleanup
    }
  }
  try {
    git(repo.path, ["branch", "-D", branch]);
  } catch {
    // branch may not exist
  }
}
