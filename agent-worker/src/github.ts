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

/**
 * A comment on a pull request — either a top-level conversation comment or an
 * inline review comment on a specific diff line. `id` is the GraphQL node id
 * (used for the 👀 reaction marker). Inline comments additionally carry the file
 * and line they were left on so a follow-up session can locate the exact spot.
 */
export interface PrComment {
  id: string;
  author: string;
  body: string;
  /** "inline" (on a diff line) or "conversation" (top-level PR thread). */
  kind: "inline" | "conversation";
  /** File path (inline comments only). */
  path?: string;
  /** Line number in the file (inline comments only). */
  line?: number;
  /** The diff hunk GitHub attaches to an inline comment, for context. */
  diffHunk?: string;
}

export interface PrFeedback {
  /** Lowercased PR state: "open" | "merged" | "closed". */
  state: string;
  /** Every human (non-bot) comment on the PR, conversation + inline. */
  comments: PrComment[];
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
    return this.listByState("open");
  }

  /**
   * Every support case (open + closed), oldest first. Used by the one-shot
   * backfill to seed central from existing GitHub history.
   */
  listAll(limit = 1000): IssueSummary[] {
    return this.listByState("all", limit);
  }

  private listByState(state: "open" | "all", limit = 100): IssueSummary[] {
    const out = this.gh([
      "issue",
      "list",
      ...this.repoArgs(),
      "--state",
      state,
      "--limit",
      String(limit),
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

  /**
   * Reopen a closed issue — e.g. a maintainer overriding a won't-fix close by
   * telling the bot to look at it anyway. The customer sees it move back to an
   * open ("under investigation") state once work restarts.
   */
  reopenIssue(number: number): void {
    this.ghMutate([
      "issue",
      "reopen",
      String(number),
      ...this.repoArgs(),
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
   *
   * `repoSlug` selects which repo's collaborator list to check: the support repo
   * for `/retry` (the default), or a code repo for PR-feedback follow-ups (the
   * PR lives there, so write access there is what authorises an amend).
   */
  isAuthorizedMaintainer(login: string, repoSlug: string = this.config.supportRepo): boolean {
    if (!login || login === this.config.botLogin) return false;
    const cacheKey = `${repoSlug}:${login}`;
    const cached = this.maintainerCache.get(cacheKey);
    if (cached !== undefined) return cached;
    let authorized = false;
    try {
      const role = this.gh([
        "api",
        `repos/${repoSlug}/collaborators/${login}/permission`,
        "-q",
        ".role_name",
      ]);
      authorized = MAINTAINER_ROLES.has(role.trim().toLowerCase());
    } catch {
      authorized = false; // not a collaborator / no access → deny
    }
    this.maintainerCache.set(cacheKey, authorized);
    return authorized;
  }

  /**
   * The first UNHANDLED `command` comment from an authorized maintainer — i.e.
   * one we haven't already reacted to. "Handled" is recorded as a 👀 reaction by
   * the bot on the comment itself (see `acknowledgeCommand`), which is the
   * idempotency key: durable across restarts, visible to the maintainer, and
   * correct no matter how many times the case stops or how many `/retry`
   * comments pile up — each is acted on exactly once.
   *
   * `afterCommentId` (the latest needs-human hand-off comment) scopes the scan to
   * the current episode so a `/retry` typed before the hand-off doesn't count; a
   * null anchor (e.g. a case parked before this was tracked) scans all comments,
   * relying on the reaction marker for idempotency. A non-maintainer using the
   * command is silently ignored.
   */
  findUnhandledCommand(
    number: number,
    afterCommentId: string | null,
    command: string,
  ): IssueComment | undefined {
    const detail = this.view(number);
    const idx = afterCommentId ? detail.comments.findIndex((c) => c.id === afterCommentId) : -1;
    const tail = idx >= 0 ? detail.comments.slice(idx + 1) : detail.comments;
    const cmd = command.toLowerCase();
    for (const c of tail) {
      if (!c.author || c.author === this.config.botLogin) continue;
      if (!c.body.toLowerCase().includes(cmd)) continue;
      if (!this.isAuthorizedMaintainer(c.author)) continue;
      if (this.hasBotReacted(c.id)) continue; // already handled
      return c;
    }
    return undefined;
  }

  /**
   * The first UNHANDLED issue comment that @-mentions the bot, from an authorized
   * maintainer. This is the issue-side analogue of the post-completion PR-feedback
   * trigger: a maintainer who disagrees with a won't-fix (or wants a parked
   * needs-human case re-attempted) just @-mentions the bot on the issue with what
   * to do, instead of remembering a slash command.
   *
   * Same gates as `findUnhandledCommand`: the author must have write access to the
   * support repo (customers never do), and the 👀 reaction marks a comment handled
   * so a single mention fires exactly once across ticks/restarts. `afterCommentId`
   * (the bot's close/hand-off comment) scopes the scan to the current episode; a
   * null anchor scans all comments and relies on the reaction marker.
   */
  findUnhandledMention(
    number: number,
    afterCommentId: string | null,
  ): IssueComment | undefined {
    const detail = this.view(number);
    const idx = afterCommentId ? detail.comments.findIndex((c) => c.id === afterCommentId) : -1;
    const tail = idx >= 0 ? detail.comments.slice(idx + 1) : detail.comments;
    // Word-bounded so `@voltini-bot` doesn't match `@voltini-bot-helper`.
    const mention = new RegExp(`@${this.config.botLogin}(?![a-zA-Z0-9-])`, "i");
    for (const c of tail) {
      if (!c.author || c.author === this.config.botLogin) continue;
      if (!mention.test(c.body)) continue;
      if (!this.isAuthorizedMaintainer(c.author)) continue;
      if (this.hasBotReacted(c.id)) continue; // already handled
      return c;
    }
    return undefined;
  }

  /**
   * Whether the bot (the token's own user) has already reacted to a comment.
   *
   * The node id may be an `IssueComment` (issue/PR-conversation comment) OR a
   * `PullRequestReviewComment` (inline diff comment) — both support reactions but
   * are distinct GraphQL types, so the query must spread over BOTH. Querying only
   * `IssueComment` would return no reaction groups for an inline comment and the
   * caller would re-handle it on every tick.
   */
  hasBotReacted(commentNodeId: string): boolean {
    try {
      const out = this.gh([
        "api",
        "graphql",
        "-f",
        "query=query($id:ID!){node(id:$id){" +
          "... on IssueComment{reactionGroups{viewerHasReacted}}" +
          "... on PullRequestReviewComment{reactionGroups{viewerHasReacted}}}}",
        "-f",
        `id=${commentNodeId}`,
      ]);
      const data = JSON.parse(out) as {
        data?: { node?: { reactionGroups?: Array<{ viewerHasReacted?: boolean }> } };
      };
      return (data.data?.node?.reactionGroups ?? []).some((g) => g.viewerHasReacted === true);
    } catch {
      return false; // can't tell → don't skip; the case leaving needs-human still guards it
    }
  }

  /**
   * Mark a command comment handled by reacting 👀 to it — the visible, durable
   * "I picked this up" signal a maintainer sees, and the idempotency marker
   * `findUnhandledCommand` checks. Best-effort: a failure won't double-process,
   * because acting on the command immediately moves the case out of needs-human.
   * `addReaction` is itself idempotent on GitHub.
   */
  acknowledgeCommand(commentNodeId: string): void {
    try {
      this.ghMutate([
        "api",
        "graphql",
        "-f",
        "query=mutation($id:ID!){addReaction(input:{subjectId:$id,content:EYES}){clientMutationId}}",
        "-f",
        `id=${commentNodeId}`,
      ]);
    } catch (e) {
      console.warn(`[github] could not react to comment ${commentNodeId}:`, String(e));
    }
  }

  /**
   * Fetch a pull request's state plus every human comment on it — both top-level
   * conversation comments and inline review comments on the diff. Targets the
   * CODE repo the PR lives in (`repoSlug`), not the support repo. The bot's own
   * comments are filtered out so its replies can never re-trigger a follow-up.
   *
   * Two reads: `gh pr view` for state + conversation comments, and the REST
   * pulls/{n}/comments endpoint for inline review comments (which `gh pr view`
   * does not return). Each comment's `id` is the GraphQL node id used for the 👀
   * reaction marker — REST exposes it as `node_id`.
   */
  prFeedback(repoSlug: string, prNumber: number): PrFeedback {
    const viewOut = this.gh([
      "pr",
      "view",
      String(prNumber),
      "-R",
      repoSlug,
      "--json",
      "state,comments",
    ]);
    const view = JSON.parse(viewOut) as {
      state: string;
      comments: Array<{ id?: string; author: { login: string }; body: string }>;
    };

    const conversation: PrComment[] = (view.comments ?? [])
      .filter((c) => c.author?.login && c.author.login !== this.config.botLogin)
      .map((c) => ({
        id: c.id ?? "",
        author: c.author.login,
        body: c.body ?? "",
        kind: "conversation" as const,
      }));

    let inline: PrComment[] = [];
    try {
      const apiOut = this.gh([
        "api",
        `repos/${repoSlug}/pulls/${prNumber}/comments`,
        "--paginate",
      ]);
      const raw = JSON.parse(apiOut) as Array<{
        node_id?: string;
        user: { login: string };
        body: string;
        path?: string;
        line?: number | null;
        original_line?: number | null;
        diff_hunk?: string;
      }>;
      inline = raw
        .filter((c) => c.user?.login && c.user.login !== this.config.botLogin)
        .map((c) => ({
          id: c.node_id ?? "",
          author: c.user.login,
          body: c.body ?? "",
          kind: "inline" as const,
          path: c.path,
          line: c.line ?? c.original_line ?? undefined,
          diffHunk: c.diff_hunk,
        }));
    } catch (e) {
      // Don't let an inline-comments fetch failure (e.g. token lacks access to
      // the code repo's PR API) drop the conversation comments we did read.
      console.warn(`[github] could not fetch inline review comments for ${repoSlug}#${prNumber}:`, String(e));
    }

    return {
      state: String(view.state ?? "").toLowerCase(),
      comments: [...conversation, ...inline],
    };
  }

  /** Post a top-level comment on a pull request in the given CODE repo. */
  replyOnPr(repoSlug: string, prNumber: number, body: string): void {
    this.ghMutate(["pr", "comment", String(prNumber), "-R", repoSlug, "--body", body]);
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
