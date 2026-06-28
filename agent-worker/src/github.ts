import { execFileSync } from "node:child_process";
import type { Config } from "./config.js";

/**
 * Thin wrapper over the `gh` CLI for the support tracker.
 *
 * Mutations (label add/remove, close, comment, pr create) are customer-facing
 * actions — they push notifications to the homeowner — so the customer-facing
 * gates that authorise them live in the pipeline, not here.
 */

export const LABEL_IN_PROGRESS = "in-progress";
export const LABEL_WONTFIX = "wontfix";
export const LABEL_NEEDS_HUMAN = "needs-human";

/** Comment command a maintainer posts to re-run a needs-human case. */
export const RETRY_COMMAND = "/retry";

/**
 * Repo permission levels that count as a maintainer (write access or above).
 * GitHub's `role_name` is one of admin/maintain/write/triage/read — only the
 * first three can push, so only those may trigger a customer-facing re-run.
 * Customers aren't repo collaborators, so they can never clear this bar.
 */
const MAINTAINER_ROLES = new Set(["admin", "maintain", "write"]);

export type SupportStatus =
  | "received"
  | "in_progress"
  | "resolved"
  | "rejected"
  | "duplicate";

export interface IssueSummary {
  number: number;
  title: string;
  labels: string[];
  state: "open" | "closed";
}

export interface IssueComment {
  id: string;
  author: string;
  body: string;
  createdAt: string;
}

export interface IssueDetail extends IssueSummary {
  body: string;
  comments: IssueComment[];
}

/**
 * Derive the customer-visible status from GitHub state — mirrors
 * support.service.ts deriveStatus on central. `in-progress` is checked FIRST,
 * which is why every close path must remove it.
 */
export function deriveStatus(
  state: string,
  stateReason: string | null,
  labels: string[],
): SupportStatus {
  const set = new Set(labels.map((l) => l.toLowerCase()));
  if (state === "open") {
    return set.has(LABEL_IN_PROGRESS) ? "in_progress" : "received";
  }
  if (set.has("duplicate") || stateReason === "duplicate") return "duplicate";
  if (stateReason === "completed") return "resolved";
  return "rejected";
}

/** The `type:*` classification label on an issue, if any. */
export function typeLabel(labels: string[]): string | undefined {
  return labels.find((l) => l.startsWith("type:"));
}

export class GitHub {
  /** Per-login authorization cache, so a repeated `/retry` poll is one API call. */
  private readonly maintainerCache = new Map<string, boolean>();

  constructor(private readonly config: Config) {}

  private env(): NodeJS.ProcessEnv {
    return { ...process.env, GH_TOKEN: this.config.ghToken };
  }

  /** Run a gh command and return stdout. Used for read-only queries. */
  private gh(args: string[], cwd?: string): string {
    return execFileSync("gh", args, {
      encoding: "utf8",
      env: this.env(),
      cwd,
      maxBuffer: 32 * 1024 * 1024,
    }).trim();
  }

  /** Run a mutating gh command. */
  private ghMutate(args: string[], cwd?: string): void {
    this.gh(args, cwd);
  }

  private repoArgs(): string[] {
    return ["-R", this.config.supportRepo];
  }

  /** Open support cases, oldest first. */
  listOpen(): IssueSummary[] {
    const out = this.gh([
      "issue",
      "list",
      ...this.repoArgs(),
      "--state",
      "open",
      "--limit",
      "100",
      "--json",
      "number,title,labels,state",
    ]);
    const rows = JSON.parse(out) as Array<{
      number: number;
      title: string;
      labels: Array<{ name: string }>;
      state: string;
    }>;
    return rows
      .map((r) => ({
        number: r.number,
        title: r.title,
        labels: r.labels.map((l) => l.name),
        state: r.state.toLowerCase() === "closed" ? ("closed" as const) : ("open" as const),
      }))
      .sort((a, b) => a.number - b.number);
  }

  view(number: number): IssueDetail {
    const out = this.gh([
      "issue",
      "view",
      String(number),
      ...this.repoArgs(),
      "--json",
      "number,title,labels,state,body,comments",
    ]);
    const r = JSON.parse(out) as {
      number: number;
      title: string;
      labels: Array<{ name: string }>;
      state: string;
      body: string;
      comments: Array<{ id?: string; author: { login: string }; body: string; createdAt: string }>;
    };
    return {
      number: r.number,
      title: r.title,
      labels: r.labels.map((l) => l.name),
      state: r.state.toLowerCase() === "closed" ? "closed" : "open",
      body: r.body ?? "",
      comments: (r.comments ?? []).map((c) => ({
        id: c.id ?? c.createdAt,
        author: c.author?.login ?? "",
        body: c.body ?? "",
        createdAt: c.createdAt,
      })),
    };
  }

  /**
   * The minimal fields needed to derive a case's true status — open/closed and
   * labels. Returns null if the issue no longer exists or isn't accessible.
   * Cheaper than `view()` (no body/comments); used for startup reconciliation.
   *
   * We deliberately do NOT request the `stateReason` field: it was only added
   * to `gh` in v2.21, so an older box errors with `Unknown JSON field:
   * "stateReason"`. Resolved-vs-won't-fix is instead derived from the `wontfix`
   * label (which the bot always sets on a won't-fix close), making this
   * gh-version-independent. See `phaseFromGitHub` in main.ts.
   */
  issueState(
    number: number,
  ): { state: "open" | "closed"; labels: string[] } | null {
    let out: string;
    try {
      out = this.gh([
        "issue",
        "view",
        String(number),
        ...this.repoArgs(),
        "--json",
        "state,labels",
      ]);
    } catch {
      return null; // deleted / transferred / no access
    }
    const r = JSON.parse(out) as {
      state: string;
      labels: Array<{ name: string }>;
    };
    return {
      state: r.state.toLowerCase() === "closed" ? "closed" : "open",
      labels: r.labels.map((l) => l.name),
    };
  }

  comment(number: number, body: string): void {
    this.ghMutate([
      "issue",
      "comment",
      String(number),
      ...this.repoArgs(),
      "--body",
      body,
    ]);
  }

  /**
   * Post a comment at most once per `marker`. The marker is embedded as an
   * invisible HTML comment, so a repeated call (e.g. every poll tick while a
   * case waits for a missing repo) finds the prior comment and skips — no spam,
   * and the guarantee survives restarts and journal wipes since it's read back
   * from GitHub itself, not from local state. Returns true only if it posted.
   */
  commentOnce(number: number, marker: string, body: string): boolean {
    const tag = `<!-- bot:${marker} -->`;
    const already = this.view(number).comments.some(
      (c) => c.author === this.config.botLogin && c.body.includes(tag),
    );
    if (already) return false;
    this.comment(number, `${body}\n\n${tag}`);
    return true;
  }

  addLabel(number: number, label: string): void {
    this.ghMutate([
      "issue",
      "edit",
      String(number),
      ...this.repoArgs(),
      "--add-label",
      label,
    ]);
  }

  removeLabel(number: number, label: string): void {
    this.ghMutate([
      "issue",
      "edit",
      String(number),
      ...this.repoArgs(),
      "--remove-label",
      label,
    ]);
  }

  /** Close as resolved → Löst. Removes in-progress first (required). */
  closeResolved(number: number, body: string): void {
    this.removeLabel(number, LABEL_IN_PROGRESS);
    this.comment(number, body);
    this.ghMutate([
      "issue",
      "close",
      String(number),
      ...this.repoArgs(),
      "--reason",
      "completed",
    ]);
  }

  /** Close as won't-fix → Avvisad. Removes in-progress, adds wontfix. */
  closeWontFix(number: number, body: string): void {
    this.removeLabel(number, LABEL_IN_PROGRESS);
    this.addLabel(number, LABEL_WONTFIX);
    this.comment(number, body);
    this.ghMutate([
      "issue",
      "close",
      String(number),
      ...this.repoArgs(),
      "--reason",
      "not planned",
    ]);
  }

  /**
   * The first comment authored by someone other than the bot, created after
   * `afterCommentId`. Used to detect a human's reply to a blocking question.
   */
  humanReplyAfter(number: number, afterCommentId: string): IssueComment | undefined {
    const detail = this.view(number);
    const idx = detail.comments.findIndex((c) => c.id === afterCommentId);
    const tail = idx >= 0 ? detail.comments.slice(idx + 1) : detail.comments;
    return tail.find((c) => c.author && c.author !== this.config.botLogin);
  }

  /** Last comment id on the issue (the question we just posted), for resume. */
  lastCommentId(number: number): string | undefined {
    const detail = this.view(number);
    return detail.comments.at(-1)?.id;
  }

  /**
   * Whether a GitHub login may trigger a customer-facing re-run — i.e. has
   * write/maintain/admin access to the support repo. The bot itself never
   * qualifies. Any API failure (404 not-a-collaborator, 403, network) is treated
   * as "not authorized", so the gate fails safe — a customer (never a repo
   * collaborator) can't pass it. Org membership is deliberately NOT used: a
   * private member reads as a 404 and the membership endpoint is often 403 to a
   * PAT, so it would wrongly deny real maintainers.
   */
  isAuthorizedMaintainer(login: string): boolean {
    if (!login || login === this.config.botLogin) return false;
    const cached = this.maintainerCache.get(login);
    if (cached !== undefined) return cached;
    let authorized = false;
    try {
      const role = this.gh([
        "api",
        `repos/${this.config.supportRepo}/collaborators/${login}/permission`,
        "-q",
        ".role_name",
      ]);
      authorized = MAINTAINER_ROLES.has(role.trim().toLowerCase());
    } catch {
      authorized = false; // not a collaborator / no access → deny
    }
    this.maintainerCache.set(login, authorized);
    return authorized;
  }

  /**
   * The first comment AFTER `afterCommentId` that contains `command` and was
   * posted by an authorized maintainer (not the bot, not a customer). Used to
   * detect a `/retry` request on a parked needs-human case. A non-maintainer
   * using the command is silently ignored — never acted on, never errored.
   */
  maintainerCommandAfter(
    number: number,
    afterCommentId: string,
    command: string,
  ): IssueComment | undefined {
    const detail = this.view(number);
    const idx = detail.comments.findIndex((c) => c.id === afterCommentId);
    const tail = idx >= 0 ? detail.comments.slice(idx + 1) : detail.comments;
    const cmd = command.toLowerCase();
    for (const c of tail) {
      if (!c.author || c.author === this.config.botLogin) continue;
      if (!c.body.toLowerCase().includes(cmd)) continue;
      if (this.isAuthorizedMaintainer(c.author)) return c;
    }
    return undefined;
  }

  /** Ensure the needs-human label exists in the repo (idempotent). */
  ensureLabels(): void {
    try {
      this.gh([
        "label",
        "create",
        LABEL_NEEDS_HUMAN,
        ...this.repoArgs(),
        "--color",
        "B60205",
        "--description",
        "Autobot needs a human to look",
        "--force",
      ]);
    } catch {
      // best effort
    }
  }
}
