/**
 * Central case journal — HTTP client.
 *
 * The worker keeps NO local database. Central (`voltini.energy-backend`) is the
 * single source of truth for every case's state: the phase machine, cost, PR
 * links, and the per-repo sub-tasks (branch, Agent SDK session id, attempt
 * counters). This module is a thin async client over the backend's
 * `/api/support/agent/*` endpoints, authenticated with the agent-worker service
 * token. It deliberately mirrors the old SQLite `StateStore` method surface so
 * the rest of the worker barely changed — every method just became `async`.
 *
 * GitHub labels remain the customer-facing source of truth for a case's status;
 * this journal is the worker's internal memory of how far each case got and the
 * artifacts it needs to resume after a crash/restart. A case can require fixes
 * in SEVERAL repos, each producing its own branch and pull request — so state is
 * split into case-level rows and per-(issue, repo) sub-tasks.
 *
 * Network failures propagate: the caller (the poll loop) treats a failed tick as
 * "retry next tick" rather than advancing on stale state. The worker never holds
 * a partial local copy to drift from.
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
  /** Customer-readable summary of how the bug was fixed (set on resolve). */
  solutionSummary: string | null;
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
  /**
   * Stop watching this sub-task's PR for follow-up feedback. Set once the PR is
   * observed merged/closed (it can no longer be amended), so the post-completion
   * PR-feedback poll doesn't re-query a dead PR every tick forever.
   */
  prWatchClosed: boolean;
  /** Concise "what was wrong / how it was fixed" from the implement session. */
  fixSummary: string | null;
  updatedAt: string;
}

// --- Wire DTOs (match the backend's support-agent.service.ts contract) ------

interface CaseDto {
  issueNumber: number;
  phase: string | null;
  title: string | null;
  error: string | null;
  costUsd: number;
  lifetimeCostUsd: number;
  needsHumanCommentId: string | null;
  solutionSummary: string | null;
  updatedAt: string | null;
  repoTasks: RepoTaskDto[];
}

interface RepoTaskDto {
  repoKey: string;
  scope: string | null;
  phase: string;
  branch: string | null;
  resumePhase: string | null;
  sessionId: string | null;
  blockedCommentId: string | null;
  testAttempts: number;
  reviewIters: number;
  prUrl: string | null;
  error: string | null;
  costUsd: number;
  reviewIncomplete: boolean;
  prWatchClosed: boolean;
  fixSummary: string | null;
  updatedAt: string;
}

interface CostResult {
  costUsd: number;
  lifetimeCostUsd: number;
  repoCostUsd: number | null;
}

function toCaseRow(dto: CaseDto): CaseRow {
  return {
    issueNumber: dto.issueNumber,
    phase: (dto.phase ?? "NEW") as Phase,
    slug: null,
    title: dto.title,
    error: dto.error,
    costUsd: dto.costUsd ?? 0,
    lifetimeCostUsd: dto.lifetimeCostUsd ?? 0,
    needsHumanCommentId: dto.needsHumanCommentId,
    solutionSummary: dto.solutionSummary,
    updatedAt: dto.updatedAt ?? "",
  };
}

function toRepoTaskRow(issueNumber: number, dto: RepoTaskDto): RepoTaskRow {
  return {
    issueNumber,
    repoKey: dto.repoKey,
    scope: dto.scope,
    phase: dto.phase as RepoPhase,
    branch: dto.branch,
    resumePhase: (dto.resumePhase as RepoPhase | null) ?? null,
    sessionId: dto.sessionId,
    blockedCommentId: dto.blockedCommentId,
    testAttempts: dto.testAttempts ?? 0,
    reviewIters: dto.reviewIters ?? 0,
    prUrl: dto.prUrl,
    error: dto.error,
    costUsd: dto.costUsd ?? 0,
    reviewIncomplete: !!dto.reviewIncomplete,
    prWatchClosed: !!dto.prWatchClosed,
    fixSummary: dto.fixSummary,
    updatedAt: dto.updatedAt ?? "",
  };
}

export class StateStore {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly token: string,
  ) {
    // Normalise: no trailing slash, so `${base}/api/...` is well-formed.
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 404) {
      // Distinguished from other failures: a missing row is a valid "not found"
      // for get-style calls, which the callers handle as `undefined`.
      throw new NotFoundError(`${method} ${path} → 404`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Central API ${method} ${path} failed: ${res.status} ${text.slice(0, 300)}`);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  private async maybe<T>(p: Promise<T>): Promise<T | undefined> {
    try {
      return await p;
    } catch (e) {
      if (e instanceof NotFoundError) return undefined;
      throw e;
    }
  }

  // --- Case-level -----------------------------------------------------------

  async get(issueNumber: number): Promise<CaseRow | undefined> {
    const dto = await this.maybe(
      this.request<CaseDto>("GET", `/api/support/agent/cases/${issueNumber}`),
    );
    return dto ? toCaseRow(dto) : undefined;
  }

  async all(): Promise<CaseRow[]> {
    const dtos = await this.request<CaseDto[]>("GET", `/api/support/agent/cases`);
    return dtos.map(toCaseRow);
  }

  async allInPhase(phase: Phase): Promise<CaseRow[]> {
    const dtos = await this.request<CaseDto[]>(
      "GET",
      `/api/support/agent/cases?phase=${encodeURIComponent(phase)}`,
    );
    return dtos.map(toCaseRow);
  }

  /** Register a case (idempotent upsert), returning its current row. */
  async ensure(issueNumber: number, title: string): Promise<CaseRow> {
    const dto = await this.request<CaseDto>(
      "PUT",
      `/api/support/agent/cases/${issueNumber}`,
      { title },
    );
    return toCaseRow(dto);
  }

  /** Patch a case's mutable columns. Only provided fields are written. */
  async update(
    issueNumber: number,
    patch: Partial<Omit<CaseRow, "issueNumber" | "updatedAt" | "slug">>,
  ): Promise<void> {
    await this.request("PATCH", `/api/support/agent/cases/${issueNumber}`, patch);
  }

  /**
   * Atomically add to the cumulative cost of a case (and, when given, the repo
   * sub-task that incurred it). Returns the case's new current-attempt total so
   * callers don't need a follow-up read. No-op (returns current) for deltas ≤ 0.
   */
  async addCost(
    issueNumber: number,
    repoKey: string | null,
    deltaUsd: number,
  ): Promise<number> {
    const result = await this.request<CostResult>(
      "POST",
      `/api/support/agent/cases/${issueNumber}/cost`,
      { repoKey, deltaUsd },
    );
    return result.costUsd ?? 0;
  }

  // --- Per-repo sub-tasks ---------------------------------------------------

  /** Create a repo sub-task in the BRANCH phase (idempotent). */
  async ensureRepoTask(
    issueNumber: number,
    repoKey: string,
    fields: { scope?: string; branch?: string },
  ): Promise<RepoTaskRow> {
    const dto = await this.request<RepoTaskDto>(
      "PUT",
      `/api/support/agent/cases/${issueNumber}/repos/${encodeURIComponent(repoKey)}`,
      { scope: fields.scope ?? null, branch: fields.branch ?? null },
    );
    return toRepoTaskRow(issueNumber, dto);
  }

  async getRepoTask(
    issueNumber: number,
    repoKey: string,
  ): Promise<RepoTaskRow | undefined> {
    // Repo tasks are embedded in the case payload — one fetch covers both.
    const tasks = await this.getRepoTasks(issueNumber);
    return tasks.find((t) => t.repoKey === repoKey);
  }

  /** All sub-tasks for a case, in stable (repoKey) order. */
  async getRepoTasks(issueNumber: number): Promise<RepoTaskRow[]> {
    const dto = await this.maybe(
      this.request<CaseDto>("GET", `/api/support/agent/cases/${issueNumber}`),
    );
    if (!dto) return [];
    return dto.repoTasks.map((t) => toRepoTaskRow(issueNumber, t));
  }

  async updateRepoTask(
    issueNumber: number,
    repoKey: string,
    patch: Partial<Omit<RepoTaskRow, "issueNumber" | "repoKey" | "updatedAt">>,
  ): Promise<void> {
    await this.request(
      "PATCH",
      `/api/support/agent/cases/${issueNumber}/repos/${encodeURIComponent(repoKey)}`,
      patch,
    );
  }

  /** No-op — there is no local connection to close. Kept for call-site parity. */
  close(): void {}
}

/** Thrown for a 404 so get-style callers can map it to `undefined`. */
class NotFoundError extends Error {}
