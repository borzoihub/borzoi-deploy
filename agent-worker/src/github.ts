import { execFileSync } from "node:child_process";
import type { Config } from "./config.js";

/**
 * Thin wrapper over the `gh` CLI for the support tracker.
 *
 * Mutations (label add/remove, close, comment, pr create) are gated by
 * config.dryRun — in dry-run we log the gh command instead of running it.
 * These are customer-facing actions (they push notifications to the homeowner),
 * so dry-run is the safe way to exercise the pipeline end-to-end.
 */

export const LABEL_IN_PROGRESS = "in-progress";
export const LABEL_WONTFIX = "wontfix";
export const LABEL_NEEDS_HUMAN = "needs-human";

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

  /** Run a mutating gh command, honouring dry-run. */
  private ghMutate(args: string[], cwd?: string): void {
    if (this.config.dryRun) {
      console.log(`[dry-run] gh ${args.join(" ")}`);
      return;
    }
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

  /** Ensure the needs-human label exists in the repo (idempotent). */
  ensureLabels(): void {
    if (this.config.dryRun) return;
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
