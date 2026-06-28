import Database from "better-sqlite3";
import { DateHelper } from "@digistrada/theworks-common";

/**
 * SQLite resume journal.
 *
 * GitHub labels are the customer-facing source of truth for a case's status;
 * this table is the worker's internal memory of how far each case got and the
 * artifacts it needs to resume after a crash/restart.
 *
 * A case can require fixes in SEVERAL repos (e.g. a bug that spans backend and
 * frontend), each producing its own branch and pull request. So state is split:
 *
 *  - `cases`      — one row per support-case issue (case-level lifecycle).
 *  - `case_repos` — one row per (issue, repo) sub-task the bot works on, each
 *                   with its own branch, phase, Agent SDK session and PR. A case
 *                   resolves only when every sub-task has opened a PR.
 */

/** Case-level lifecycle. Per-repo work lives in RepoPhase on the sub-tasks. */
export type Phase =
  | "NEW" // not yet triaged
  | "WORKING" // triaged fixable; one or more repo sub-tasks in flight
  | "DONE" // every sub-task resolved + issue closed
  | "BLOCKED" // at least one sub-task waiting on a human reply
  | "WONTFIX" // triaged not-fixable + closed
  | "NEEDS_HUMAN" // gave up safely, left open for a human
  | "ABORTED"; // unrecoverable error

/** Per-repo sub-task lifecycle. */
export type RepoPhase =
  | "BRANCH" // worktree to be created
  | "IMPLEMENT" // implementing the fix
  | "TEST" // running/authoring tests
  | "REVIEW" // self-review loop
  | "PR" // pushing + opening the PR
  | "DONE" // PR opened
  | "BLOCKED" // waiting for a human reply to a question
  | "NEEDS_HUMAN"; // this repo gave up safely

const TIMESTAMP_FORMAT = "YYYY-MM-DD HH:mm:ss";

export interface CaseRow {
  issueNumber: number;
  phase: Phase;
  slug: string | null;
  title: string | null;
  error: string | null;
  /**
   * Notional USD spent on the CURRENT attempt — what the budget envelope is
   * measured against. Reset to 0 when a maintainer `/retry`s, so a re-run gets a
   * fresh envelope. For the lifetime total, see `lifetimeCostUsd`.
   */
  costUsd: number;
  /**
   * Cumulative notional USD across ALL attempts (never reset) — the durable
   * per-bug cost record. Use this, not `costUsd`, to report what a bug cost.
   */
  lifetimeCostUsd: number;
  /**
   * Id of the bot's needs-human comment — the anchor a `/retry` must come AFTER.
   * Null for cases parked before this was tracked (they can't be `/retry`d; use
   * the manual label path).
   */
  needsHumanCommentId: string | null;
  updatedAt: string;
}

export interface RepoTaskRow {
  issueNumber: number;
  repoKey: string;
  /** What to fix in THIS repo (triage's per-repo scope). */
  scope: string | null;
  phase: RepoPhase;
  branch: string | null;
  /** Phase to resume into once a BLOCKED sub-task gets its human reply. */
  resumePhase: RepoPhase | null;
  /** Agent SDK session id, for resuming a paused conversation. */
  sessionId: string | null;
  /** Comment id of the last question we posted (BLOCKED sub-tasks). */
  blockedCommentId: string | null;
  testAttempts: number;
  reviewIters: number;
  prUrl: string | null;
  error: string | null;
  /** Notional USD spent on this repo sub-task (for per-repo cost breakdown). */
  costUsd: number;
  /**
   * The review read-pass was cut off by the budget/turn ceiling before it could
   * vouch for the diff. The work still ships (a soft-fail), but the case-close
   * comment is annotated so a human knows the automated review was incomplete.
   */
  reviewIncomplete: boolean;
  updatedAt: string;
}

interface RawCase {
  issue_number: number;
  phase: string;
  slug: string | null;
  title: string | null;
  error: string | null;
  cost_usd: number;
  lifetime_cost_usd: number;
  needs_human_comment_id: string | null;
  updated_at: string;
}

interface RawRepoTask {
  issue_number: number;
  repo_key: string;
  scope: string | null;
  phase: string;
  branch: string | null;
  resume_phase: string | null;
  session_id: string | null;
  blocked_comment_id: string | null;
  test_attempts: number;
  review_iters: number;
  pr_url: string | null;
  error: string | null;
  cost_usd: number;
  review_incomplete: number;
  updated_at: string;
}

function toCaseRow(raw: RawCase): CaseRow {
  return {
    issueNumber: raw.issue_number,
    phase: raw.phase as Phase,
    slug: raw.slug,
    title: raw.title,
    error: raw.error,
    costUsd: raw.cost_usd ?? 0,
    lifetimeCostUsd: raw.lifetime_cost_usd ?? 0,
    needsHumanCommentId: raw.needs_human_comment_id,
    updatedAt: raw.updated_at,
  };
}

function toRepoTaskRow(raw: RawRepoTask): RepoTaskRow {
  return {
    issueNumber: raw.issue_number,
    repoKey: raw.repo_key,
    scope: raw.scope,
    phase: raw.phase as RepoPhase,
    branch: raw.branch,
    resumePhase: raw.resume_phase as RepoPhase | null,
    sessionId: raw.session_id,
    blockedCommentId: raw.blocked_comment_id,
    testAttempts: raw.test_attempts,
    reviewIters: raw.review_iters,
    prUrl: raw.pr_url,
    error: raw.error,
    costUsd: raw.cost_usd ?? 0,
    reviewIncomplete: (raw.review_incomplete ?? 0) === 1,
    updatedAt: raw.updated_at,
  };
}

export class StateStore {
  private readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cases (
        issue_number INTEGER PRIMARY KEY,
        phase        TEXT NOT NULL,
        slug              TEXT,
        title             TEXT,
        error             TEXT,
        cost_usd          REAL NOT NULL DEFAULT 0,
        lifetime_cost_usd REAL NOT NULL DEFAULT 0,
        needs_human_comment_id TEXT,
        updated_at        TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS case_repos (
        issue_number       INTEGER NOT NULL,
        repo_key           TEXT NOT NULL,
        scope              TEXT,
        phase              TEXT NOT NULL,
        branch             TEXT,
        resume_phase       TEXT,
        session_id         TEXT,
        blocked_comment_id TEXT,
        test_attempts      INTEGER NOT NULL DEFAULT 0,
        review_iters       INTEGER NOT NULL DEFAULT 0,
        pr_url             TEXT,
        error              TEXT,
        cost_usd           REAL NOT NULL DEFAULT 0,
        review_incomplete  INTEGER NOT NULL DEFAULT 0,
        updated_at         TEXT NOT NULL,
        PRIMARY KEY (issue_number, repo_key)
      );
    `);
    this.migrate();
  }

  /**
   * Add columns introduced after a DB was first created. `ADD COLUMN` is a
   * no-op-if-present pattern here: SQLite has no "IF NOT EXISTS" for columns, so
   * we just attempt each and ignore the "duplicate column name" error. New DBs
   * already have them from CREATE TABLE above; this only patches older ones.
   */
  private migrate(): void {
    const additions: Array<[string, string]> = [
      ["cases", "cost_usd REAL NOT NULL DEFAULT 0"],
      ["cases", "lifetime_cost_usd REAL NOT NULL DEFAULT 0"],
      ["cases", "needs_human_comment_id TEXT"],
      ["case_repos", "cost_usd REAL NOT NULL DEFAULT 0"],
      ["case_repos", "review_incomplete INTEGER NOT NULL DEFAULT 0"],
    ];
    for (const [table, column] of additions) {
      try {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column}`);
      } catch (e) {
        if (!/duplicate column name/i.test(String(e))) throw e;
      }
    }
  }

  private now(): string {
    return DateHelper.format(new Date(), TIMESTAMP_FORMAT);
  }

  // --- Case-level -----------------------------------------------------------

  get(issueNumber: number): CaseRow | undefined {
    const raw = this.db
      .prepare("SELECT * FROM cases WHERE issue_number = ?")
      .get(issueNumber) as RawCase | undefined;
    return raw ? toCaseRow(raw) : undefined;
  }

  all(): CaseRow[] {
    const raws = this.db
      .prepare("SELECT * FROM cases ORDER BY issue_number")
      .all() as RawCase[];
    return raws.map(toCaseRow);
  }

  allInPhase(phase: Phase): CaseRow[] {
    return this.all().filter((c) => c.phase === phase);
  }

  /** Insert a brand-new case in the NEW phase. No-op if it already exists. */
  ensure(issueNumber: number, title: string): CaseRow {
    const existing = this.get(issueNumber);
    if (existing) return existing;
    this.db
      .prepare(
        `INSERT INTO cases (issue_number, phase, title, updated_at)
         VALUES (?, 'NEW', ?, ?)`,
      )
      .run(issueNumber, title, this.now());
    return this.get(issueNumber)!;
  }

  /** Patch a case's mutable columns. Only provided fields are written. */
  update(
    issueNumber: number,
    patch: Partial<Omit<CaseRow, "issueNumber" | "updatedAt">>,
  ): void {
    const columns: Record<keyof Omit<CaseRow, "issueNumber" | "updatedAt">, string> = {
      phase: "phase",
      slug: "slug",
      title: "title",
      error: "error",
      costUsd: "cost_usd",
      lifetimeCostUsd: "lifetime_cost_usd",
      needsHumanCommentId: "needs_human_comment_id",
    };
    this.patch("cases", columns, patch, ["issue_number = ?"], [issueNumber]);
  }

  /**
   * Atomically add to the cumulative cost of a case (and, when given, the repo
   * sub-task that incurred it). Used after every Agent SDK session so the case
   * budget envelope and the per-bug cost record stay current.
   */
  addCost(issueNumber: number, repoKey: string | null, deltaUsd: number): void {
    if (!(deltaUsd > 0)) return;
    const now = this.now();
    // cost_usd is the current-attempt counter (reset on /retry); lifetime is the
    // durable total that survives retries.
    this.db
      .prepare(
        "UPDATE cases SET cost_usd = cost_usd + ?, lifetime_cost_usd = lifetime_cost_usd + ?, updated_at = ? WHERE issue_number = ?",
      )
      .run(deltaUsd, deltaUsd, now, issueNumber);
    if (repoKey) {
      this.db
        .prepare(
          "UPDATE case_repos SET cost_usd = cost_usd + ?, updated_at = ? WHERE issue_number = ? AND repo_key = ?",
        )
        .run(deltaUsd, now, issueNumber, repoKey);
    }
  }

  // --- Per-repo sub-tasks ---------------------------------------------------

  /** Create a repo sub-task in the BRANCH phase. No-op if it already exists. */
  ensureRepoTask(
    issueNumber: number,
    repoKey: string,
    fields: { scope?: string; branch?: string },
  ): RepoTaskRow {
    const existing = this.getRepoTask(issueNumber, repoKey);
    if (existing) return existing;
    this.db
      .prepare(
        `INSERT INTO case_repos (issue_number, repo_key, scope, phase, branch, updated_at)
         VALUES (?, ?, ?, 'BRANCH', ?, ?)`,
      )
      .run(issueNumber, repoKey, fields.scope ?? null, fields.branch ?? null, this.now());
    return this.getRepoTask(issueNumber, repoKey)!;
  }

  getRepoTask(issueNumber: number, repoKey: string): RepoTaskRow | undefined {
    const raw = this.db
      .prepare("SELECT * FROM case_repos WHERE issue_number = ? AND repo_key = ?")
      .get(issueNumber, repoKey) as RawRepoTask | undefined;
    return raw ? toRepoTaskRow(raw) : undefined;
  }

  /** All sub-tasks for a case, in stable (repo_key) order. */
  getRepoTasks(issueNumber: number): RepoTaskRow[] {
    const raws = this.db
      .prepare("SELECT * FROM case_repos WHERE issue_number = ? ORDER BY repo_key")
      .all(issueNumber) as RawRepoTask[];
    return raws.map(toRepoTaskRow);
  }

  updateRepoTask(
    issueNumber: number,
    repoKey: string,
    patch: Partial<Omit<RepoTaskRow, "issueNumber" | "repoKey" | "updatedAt">>,
  ): void {
    const columns: Record<
      keyof Omit<RepoTaskRow, "issueNumber" | "repoKey" | "updatedAt">,
      string
    > = {
      scope: "scope",
      phase: "phase",
      branch: "branch",
      resumePhase: "resume_phase",
      sessionId: "session_id",
      blockedCommentId: "blocked_comment_id",
      testAttempts: "test_attempts",
      reviewIters: "review_iters",
      prUrl: "pr_url",
      error: "error",
      costUsd: "cost_usd",
      reviewIncomplete: "review_incomplete",
    };
    this.patch(
      "case_repos",
      columns,
      patch,
      ["issue_number = ?", "repo_key = ?"],
      [issueNumber, repoKey],
    );
  }

  // --- shared patch helper --------------------------------------------------

  private patch(
    table: string,
    columns: Record<string, string>,
    patchObj: Record<string, unknown>,
    where: string[],
    whereValues: unknown[],
  ): void {
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, column] of Object.entries(columns)) {
      const value = patchObj[key];
      if (value !== undefined) {
        sets.push(`${column} = ?`);
        // better-sqlite3 can't bind booleans — store them as 0/1.
        values.push(typeof value === "boolean" ? (value ? 1 : 0) : value);
      }
    }
    sets.push("updated_at = ?");
    values.push(this.now());
    values.push(...whereValues);
    this.db
      .prepare(`UPDATE ${table} SET ${sets.join(", ")} WHERE ${where.join(" AND ")}`)
      .run(...values);
  }

  close(): void {
    this.db.close();
  }
}
