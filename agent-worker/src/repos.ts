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
  try {
    // Capture stderr instead of inheriting it: several callers intentionally run
    // git commands that may fail (e.g. `branch -D` on a not-yet-created branch in
    // freshWorktree, `worktree remove` on a stale path) and swallow the error.
    // With inherited stderr those handled failures still print scary lines like
    // "error: branch '…' not found" to the operator console.
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (e) {
    // Genuine (uncaught) failures must keep their diagnostics — fold git's
    // captured stderr into the thrown error so it isn't silently lost.
    const err = e as { stderr?: Buffer | string; message?: string };
    const detail = err.stderr ? String(err.stderr).trim() : "";
    if (detail && err.message) err.message = `${err.message}\n${detail}`;
    throw e;
  }
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

/**
 * Find a local branch this issue's work was done on, without knowing its exact
 * name. Branches are `<prefix>/<issueNumber>-<slug>` where the prefix
 * (bugfix/features/improvements) and slug are chosen by triage and so aren't
 * reconstructable after a journal wipe — but the issue number always anchors the
 * segment right after the `/`. Matches any prefix (including legacy `features/`).
 * Returns the first match, or undefined when none exists.
 */
export function findIssueBranch(repo: Repo, issueNumber: number): string | undefined {
  try {
    // The trailing "-" after the number keeps issue 3 from matching "30-…".
    const out = git(repo.path, [
      "branch",
      "--list",
      "--format=%(refname:short)",
      `*/${issueNumber}-*`,
    ]);
    const first = out.split("\n").map((l) => l.trim()).find(Boolean);
    return first || undefined;
  } catch {
    return undefined;
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
 * Stage + commit everything in the branch's worktree, for the pause path: when
 * an operator pauses a case we abort the running session and preserve whatever
 * it produced as a commit on the branch (rather than lose it or leave a dirty
 * worktree a resume would have to reconcile). No-op returning false when the
 * worktree is missing or clean; true when a commit was made. Best-effort — a
 * failure here must not mask the PauseError that triggered it.
 */
export function commitWorktree(repo: Repo, branch: string, message: string): boolean {
  const path = worktreePath(repo, branch);
  if (!existsSync(path) || !isWorktreeDirty(repo, branch)) return false;
  try {
    git(path, ["add", "-A"]);
    git(path, ["commit", "--no-verify", "-m", message]);
    return true;
  } catch (e) {
    console.error(`[repos] ${repo.key}: could not commit paused work on ${branch}:`, String(e));
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
 * A worktree synced to the tip of an EXISTING remote branch (origin/<branch>).
 *
 * Used to reopen work on a PR's branch after the case completed — e.g. to address
 * post-merge-review PR feedback. Unlike `freshWorktree` (which resets to
 * origin/<base> and would throw away the PR's commits), this fetches the PR
 * branch and hard-resets the worktree to it, so the session builds on exactly
 * what the open PR contains. The hard reset also discards any leftover local
 * commits from a crashed prior feedback round, keeping rounds idempotent: the
 * remote PR branch is the single source of truth.
 */
export function syncWorktreeToRemoteBranch(repo: Repo, branch: string): string {
  const path = ensureWorktree(repo, branch, branch);
  git(repo.path, ["fetch", "origin", branch]);
  git(path, ["reset", "--hard", `origin/${branch}`]);
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
  // Start-over semantics: drop both the worktree AND the branch, so the
  // ensureWorktree below re-creates the branch fresh off origin/<base> rather
  // than re-attaching to the stale one.
  removeWorktree(repo, branch);
  deleteBranch(repo, branch);
  return ensureWorktree(repo, branch, base);
}

/**
 * Remove a worktree but KEEP its branch. This is the normal post-PR cleanup:
 * once the PR is open the branch lives on the remote and the PR needs it, so we
 * only reclaim the local worktree's disk. Branch deletion is a separate, explicit
 * step (`deleteBranch`) reserved for genuinely abandoning unpushed work.
 */
export function removeWorktree(repo: Repo, branch: string): void {
  const path = worktreePath(repo, branch);
  if (existsSync(path)) {
    try {
      git(repo.path, ["worktree", "remove", "--force", path]);
    } catch {
      // ignore — best effort cleanup
    }
  }
}

/**
 * Force-delete a local branch. Only for starting a fresh attempt over a stale
 * branch (see `freshWorktree`) — never call this after a PR has been opened, the
 * PR's head branch must survive.
 */
export function deleteBranch(repo: Repo, branch: string): void {
  try {
    git(repo.path, ["branch", "-D", branch]);
  } catch {
    // branch may not exist
  }
}

/**
 * A short, human-readable summary of the work ALREADY on `branch` — commits
 * ahead of base, the files they touched, and any still-uncommitted changes.
 * Fed to a resuming agent so it builds on prior work instead of starting blind
 * (every resume runs a fresh Agent SDK session with no memory of the previous
 * one). Returns "" for genuinely fresh work (no commits, clean worktree).
 */
export function priorWorkSummary(repo: Repo, branch: string, base: string): string {
  const wt = worktreePath(repo, branch);
  if (!existsSync(wt)) return "";
  const sections: string[] = [];
  try {
    const log = git(wt, ["log", `origin/${base}..HEAD`, "--oneline"]);
    if (log) sections.push(`Commits already on this branch (vs origin/${base}):\n${log}`);
    const stat = git(wt, ["diff", `origin/${base}...HEAD`, "--stat"]);
    if (stat) sections.push(`Files changed by those commits:\n${stat}`);
    const dirty = git(wt, ["status", "--porcelain"]);
    if (dirty) sections.push(`Uncommitted changes still in the worktree:\n${dirty}`);
  } catch {
    // best effort — return whatever we gathered before the failure
  }
  return sections.join("\n\n");
}
