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

/** The `owner/name` GitHub slug from the repo's origin remote, if any. */
export function repoSlug(repo: Repo): string | undefined {
  try {
    const url = git(repo.path, ["remote", "get-url", "origin"]);
    const m = url.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
    return m?.[1];
  } catch {
    return undefined;
  }
}

/** Does a local branch with this name exist in the repo? */
export function localBranchExists(repo: Repo, branch: string): boolean {
  try {
    git(repo.path, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

/** Is there already a worktree checked out for this branch? */
export function hasWorktree(repo: Repo, branch: string): boolean {
  return existsSync(worktreePath(repo, branch));
}

/**
 * Does the branch's worktree have uncommitted or untracked changes — i.e. work
 * a previous attempt started but didn't commit (e.g. it was killed mid-fix)?
 */
export function isWorktreeDirty(repo: Repo, branch: string): boolean {
  const path = worktreePath(repo, branch);
  if (!existsSync(path)) return false;
  try {
    return git(path, ["status", "--porcelain"]).length > 0;
  } catch {
    return false;
  }
}

/**
 * How many commits `branch` has that `origin/<base>` does not — i.e. how much
 * work a previous attempt already committed. 0 means the branch is empty/at base.
 */
export function commitsAhead(repo: Repo, branch: string, base: string): number {
  try {
    git(repo.path, ["fetch", "origin", base]);
  } catch {
    // offline / no remote — compare against whatever we have locally
  }
  try {
    const out = git(repo.path, ["rev-list", "--count", `origin/${base}..${branch}`]);
    return Number(out) || 0;
  } catch {
    return 0;
  }
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
  if (localBranchExists(repo, branch)) {
    // Branch already exists (e.g. a previous attempt committed but its worktree
    // was pruned) — attach a worktree to it WITHOUT discarding its commits.
    git(repo.path, ["worktree", "add", path, branch]);
  } else {
    // Fresh branch + worktree off origin/<base>.
    git(repo.path, ["worktree", "add", "-b", branch, path, `origin/${base}`]);
  }
  return path;
}

/**
 * A guaranteed-clean worktree off origin/<base> — removes any stale worktree
 * and branch first. Used when starting fresh work, so a half-finished previous
 * attempt can't silently contaminate a new run. (For RESUMING prior work, use
 * ensureWorktree, which preserves existing commits.)
 */
export function freshWorktree(repo: Repo, branch: string, base: string): string {
  // Refuse to throw away uncommitted work — recovery should have caught a dirty
  // worktree before we get here, but never destroy changes silently if not.
  if (isWorktreeDirty(repo, branch)) {
    console.warn(
      `[repos] ${repo.key}: worktree for ${branch} has uncommitted changes — reusing it instead of resetting.`,
    );
    return ensureWorktree(repo, branch, base);
  }
  removeWorktree(repo, branch);
  return ensureWorktree(repo, branch, base);
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
