import { query, AbortError, type Options } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "./config.js";
import { createAskHuman, type AskHumanHandle } from "./askHuman.js";
import { createInstallationData } from "./installationData.js";

/**
 * Thin wrapper over the Claude Agent SDK `query()`.
 *
 * Each call runs one (possibly multi-turn) agent session inside a cloned repo
 * worktree, with permissions bypassed so it can edit files, run bash, git, gh
 * and npm unattended. The Agent SDK authenticates to the Claude backend itself
 * — against a Claude subscription via CLAUDE_CODE_OAUTH_TOKEN (surfaced from the
 * environment in main.ts).
 */

/** How often to print a "still working" heartbeat during a session. */
const HEARTBEAT_SEC = 15;
/** Warn in the heartbeat if the SDK hasn't emitted a message for this long. */
const STALL_WARN_SEC = 90;
/**
 * Abort a session that has produced NO output for this long — almost always a
 * wedged request (e.g. API throttling that never recovers) rather than a
 * slow inference. Aborting lets the case retry next tick instead of hanging the
 * single-threaded poll loop forever.
 */
const STALL_ABORT_SEC = 360;

/** A short, human-readable description of what a streamed SDK message represents. */
function describeActivity(message: unknown): string | undefined {
  const m = message as { type?: string; subtype?: string; message?: { content?: unknown[] } };
  if (m.type === "assistant") {
    const blocks = m.message?.content ?? [];
    for (const b of blocks) {
      const block = b as { type?: string; name?: string };
      if (block.type === "tool_use") return `running tool: ${block.name ?? "?"}`;
    }
    return "thinking / writing";
  }
  if (m.type === "user") return "got tool result";
  if (m.type === "result") return `result (${m.subtype ?? "?"})`;
  if (m.type === "system") return `system${m.subtype ? `: ${m.subtype}` : ""}`;
  return undefined;
}

export interface RunOptions {
  cwd: string;
  prompt: string;
  systemPrompt?: string;
  maxTurns?: number;
  /**
   * Notional USD budget for THIS session. The SDK stops the agent loop once the
   * session's cost exceeds it, returning an `error_max_budget_usd` result. The
   * orchestrator passes the case's remaining envelope here so a runaway session
   * can't overspend the per-case ceiling. Enforced after a turn completes, so
   * actual spend can overshoot by up to one turn's cost.
   */
  maxBudgetUsd?: number;
  /** Session id to resume (continues a parked conversation). */
  resume?: string;
  /** JSON schema; when set, the session returns validated structured output. */
  outputSchema?: Record<string, unknown>;
  /** Enable the ask_human channel (implement/review sessions). */
  enableAskHuman?: boolean;
  /**
   * Enable the read-only live-installation-data tools (get_installation_catalog
   * + query_installation_data) for the given case. Used by triage and implement
   * to investigate the reporting Hub's real energy data via central.
   */
  dataQuery?: { issueNumber: number };
  /** Short label for log lines, e.g. "triage #22". Defaults to the cwd. */
  label?: string;
}

export interface RunResult {
  text: string;
  sessionId: string | undefined;
  structuredOutput: unknown;
  isError: boolean;
  /** ask_human was invoked — the session is parked. */
  blocked: boolean;
  question: string | undefined;
  /** Notional USD this session cost (from the SDK's `total_cost_usd`); 0 if unknown. */
  costUsd: number;
  /**
   * The session stopped because it hit a budget/turn ceiling
   * (`error_max_budget_usd` / `error_max_turns`) rather than finishing or
   * crashing. Callers route this distinctly: hard-fail for implement/test/fix,
   * soft-fail (proceed) for the advisory review read-pass.
   */
  limitHit: boolean;
}

/**
 * Result subtypes the SDK emits when a session is cut off by a ceiling rather
 * than failing. NOTE: on these the SDK yields this result message AND THEN
 * throws `Error: Claude Code returned an error result: Reached maximum ...`
 * after the stream — so we both read the subtype here and swallow the matching
 * throw in the catch below.
 */
const LIMIT_SUBTYPES = new Set(["error_max_turns", "error_max_budget_usd"]);
const LIMIT_THROW_RE = /Reached maximum (number of turns|budget)/i;

/**
 * Thrown when an in-flight session is cancelled because the worker is shutting
 * down (operator hit Ctrl-C / SIGTERM). Distinct from a normal error so the
 * pipeline does NOT mark the case needs-human or post a customer-facing comment
 * on the way out — it just unwinds cleanly.
 */
export class ShutdownError extends Error {
  constructor(message = "worker is shutting down") {
    super(message);
    this.name = "ShutdownError";
  }
}

/**
 * Thrown when an in-flight session is aborted because an operator paused the
 * case (from the installer portal) and the 2-minute grace elapsed. Distinct
 * from ShutdownError (the worker keeps running — only this case stops) and from
 * a normal error (the pipeline must NOT flag needs-human): the case is left on
 * its committed branch to be resumed later.
 */
export class PauseError extends Error {
  constructor(message = "case paused by operator") {
    super(message);
    this.name = "PauseError";
  }
}

export class ClaudeRunner {
  /** Abort controllers for every in-flight session, so shutdown can cancel them. */
  private readonly active = new Set<AbortController>();
  private shuttingDown = false;
  /** Set while a pause abort is in flight so the catch classifies the resulting
   *  AbortError as a PauseError rather than a stall/limit. */
  private pausing = false;

  constructor(private readonly config: Config) {}

  /**
   * Cancel every in-flight session and refuse to start new ones. Called from the
   * SIGINT/SIGTERM handler so Ctrl-C interrupts a running Claude session
   * immediately instead of waiting for it (or the poll sleep) to finish.
   */
  shutdown(): void {
    this.shuttingDown = true;
    for (const c of this.active) c.abort();
  }

  /**
   * Abort the in-flight session because its case was paused past the grace
   * window. Unlike `shutdown`, the worker stays up — only the current session is
   * cut, surfacing as a PauseError the pipeline catches to commit + stop. The
   * worker processes one case at a time, so the only active session is this
   * case's. Cleared with `clearPause()` once the case has unwound.
   */
  requestPause(): void {
    this.pausing = true;
    for (const c of this.active) c.abort();
  }

  /** Reset the pause latch after a paused case has unwound (see requestPause). */
  clearPause(): void {
    this.pausing = false;
  }

  async run(opts: RunOptions): Promise<RunResult> {
    if (this.shuttingDown) throw new ShutdownError();
    if (this.pausing) throw new PauseError();
    const abort = new AbortController();
    this.active.add(abort);
    let askHuman: AskHumanHandle | undefined;

    const options: Options = {
      cwd: opts.cwd,
      model: this.config.model,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      abortController: abort,
      // Load the cloned repo's CLAUDE.md + project settings so the agent
      // follows that project's conventions automatically.
      settingSources: ["project"],
    };

    if (opts.systemPrompt !== undefined) {
      options.systemPrompt = opts.systemPrompt;
    }
    if (opts.maxTurns !== undefined) {
      options.maxTurns = opts.maxTurns;
    }
    if (opts.maxBudgetUsd !== undefined) {
      options.maxBudgetUsd = opts.maxBudgetUsd;
    }
    if (opts.resume !== undefined) {
      options.resume = opts.resume;
    }
    if (opts.outputSchema !== undefined) {
      // The Agent SDK's json_schema output silently returns no structured
      // output when the schema carries a top-level "$schema" key (which Zod 4's
      // z.toJSONSchema emits). Strip it so structured output is actually
      // produced. See .env runbook / the structured-output regression.
      const { $schema: _drop, ...schema } = opts.outputSchema as Record<string, unknown>;
      options.outputFormat = { type: "json_schema", schema };
    }
    // Both the ask_human channel and the live-data tools are SDK MCP servers;
    // merge them so a session can carry both at once (implement uses both).
    const mcpServers: NonNullable<Options["mcpServers"]> = {};
    if (opts.enableAskHuman) {
      askHuman = createAskHuman(abort);
      mcpServers[askHuman.serverName] = askHuman.server;
    }
    if (opts.dataQuery) {
      const data = createInstallationData(this.config, opts.dataQuery.issueNumber);
      mcpServers[data.serverName] = data.server;
    }
    if (Object.keys(mcpServers).length > 0) {
      options.mcpServers = mcpServers;
    }

    const label = opts.label ?? opts.cwd;
    const wantsStructured = opts.outputSchema !== undefined;

    // Capture the Claude Code process's stderr — this is where API retry /
    // throttle / error messages surface. We keep the most recent line so the
    // heartbeat can show WHY a session has gone quiet during a stall.
    let lastStderr = "";
    options.stderr = (data: string) => {
      const line = data.trim().split("\n").filter(Boolean).pop();
      if (line) lastStderr = line;
    };

    console.log(
      `[claude] ${label}: starting session (model ${this.config.model}, maxTurns ${opts.maxTurns ?? "default"}` +
        `${opts.maxBudgetUsd !== undefined ? `, budget $${opts.maxBudgetUsd.toFixed(2)}` : ""}` +
        `${wantsStructured ? ", structured output" : ""})`,
    );

    let sessionId: string | undefined;
    let text = "";
    let structuredOutput: unknown;
    let isError = false;
    let resultSubtype: string | undefined;
    let turns: number | undefined;
    let costUsd = 0;

    // Liveness: a long implement/review session is otherwise silent for minutes.
    // Emit a heartbeat with elapsed time, message count and last activity so an
    // operator can tell it's still working — and warn if the SDK goes quiet
    // (a possible stall) so a hang is visible rather than looking like progress.
    const startedAt = Date.now();
    let msgCount = 0;
    let lastActivity = "starting up";
    let lastMsgAt = startedAt;
    let stalledOut = false;
    const heartbeat = setInterval(() => {
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      const quietFor = Math.round((Date.now() - lastMsgAt) / 1000);
      let stall = "";
      if (quietFor >= STALL_WARN_SEC) {
        // Surface the last SDK stderr line — that's where throttle/retry shows.
        stall = ` ⚠ no activity for ${quietFor}s — possible stall${lastStderr ? ` | sdk: ${lastStderr}` : ""}`;
      }
      console.log(
        `[claude] ${label}: …working — ${elapsed}s elapsed, ${msgCount} msgs, last: ${lastActivity}${stall}`,
      );
      if (quietFor >= STALL_ABORT_SEC && !stalledOut) {
        stalledOut = true;
        console.error(
          `[claude] ${label}: aborting — no activity for ${quietFor}s (wedged session); the case will retry next tick.`,
        );
        abort.abort();
      }
    }, HEARTBEAT_SEC * 1000);
    if (typeof heartbeat.unref === "function") heartbeat.unref();

    try {
      for await (const message of query({ prompt: opts.prompt, options })) {
        msgCount += 1;
        lastMsgAt = Date.now();
        const activity = describeActivity(message);
        if (activity) lastActivity = activity;
        if ("session_id" in message && message.session_id) {
          sessionId = message.session_id;
        }
        if (message.type === "result") {
          resultSubtype = message.subtype;
          isError = message.subtype !== "success";
          turns = "num_turns" in message ? message.num_turns : undefined;
          // The cost field is present on success AND on error results (incl.
          // the budget/turn ceilings) — always capture it for case accounting.
          if ("total_cost_usd" in message && typeof message.total_cost_usd === "number") {
            costUsd = message.total_cost_usd;
          }
          if (message.subtype === "success") {
            text = message.result;
            structuredOutput = message.structured_output;
          }
        }
      }
    } catch (e) {
      // Operator shutdown (Ctrl-C/SIGTERM) aborted the session — surface a
      // distinct error so the pipeline unwinds without flagging needs-human.
      if (this.shuttingDown && e instanceof AbortError) {
        throw new ShutdownError();
      }
      // Operator paused this case past the grace window — surface a distinct
      // error so the pipeline commits the in-flight work and stops (not
      // needs-human). Checked before the stall/limit branches: a pause abort
      // must never be misread as a wedged session.
      if (this.pausing && e instanceof AbortError) {
        throw new PauseError();
      }
      // ask_human aborts the session deliberately; that is not a failure.
      if (askHuman?.wasAsked() && e instanceof AbortError) {
        clearInterval(heartbeat);
        return {
          text,
          sessionId,
          structuredOutput,
          isError: false,
          blocked: true,
          question: askHuman.question(),
          costUsd,
          limitHit: false,
        };
      }
      // We aborted a wedged session on the stall timeout — report it as an
      // error result (not a thrown crash) so the caller can retry/route it.
      if (stalledOut && e instanceof AbortError) {
        clearInterval(heartbeat);
        return { text, sessionId, structuredOutput, isError: true, blocked: false, question: undefined, costUsd, limitHit: false };
      }
      // Budget/turn ceiling. The SDK already yielded the error result (so we have
      // the subtype + cost) and is NOW throwing a matching "Reached maximum ..."
      // error. Swallow that throw and return a clean limit signal — don't let the
      // raw SDK string bubble to the orchestrator's generic catch-all.
      const message = e instanceof Error ? e.message : String(e);
      if ((resultSubtype && LIMIT_SUBTYPES.has(resultSubtype)) || LIMIT_THROW_RE.test(message)) {
        clearInterval(heartbeat);
        console.log(
          `[claude] ${label}: stopped at ${resultSubtype ?? "limit"} after $${costUsd.toFixed(4)} — returning a clean limit signal.`,
        );
        return { text, sessionId, structuredOutput, isError: true, blocked: false, question: undefined, costUsd, limitHit: true };
      }
      throw e;
    } finally {
      clearInterval(heartbeat);
      this.active.delete(abort);
    }

    const limitHit = resultSubtype ? LIMIT_SUBTYPES.has(resultSubtype) : false;
    console.log(
      `[claude] ${label}: finished — subtype=${resultSubtype ?? "none"}, turns=${turns ?? "?"}, ` +
        `cost=$${costUsd.toFixed(4)}, ` +
        `structuredOutput=${structuredOutput === undefined ? "MISSING" : "present"}, textLen=${text.length}`,
    );
    // When we asked for structured output but the model returned none, the raw
    // assistant text is the only clue to why — surface it for diagnosis.
    if (wantsStructured && structuredOutput === undefined) {
      console.warn(
        `[claude] ${label}: expected structured output but got none. Raw result text:\n${text || "(empty)"}`,
      );
    }

    return {
      text,
      sessionId,
      structuredOutput,
      isError,
      blocked: askHuman?.wasAsked() ?? false,
      question: askHuman?.question(),
      costUsd,
      limitHit,
    };
  }
}
