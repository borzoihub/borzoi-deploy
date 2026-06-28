import { query, AbortError, type Options } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "./config.js";
import { createAskHuman, type AskHumanHandle } from "./askHuman.js";

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
  /** Session id to resume (continues a parked conversation). */
  resume?: string;
  /** JSON schema; when set, the session returns validated structured output. */
  outputSchema?: Record<string, unknown>;
  /** Enable the ask_human channel (implement/review sessions). */
  enableAskHuman?: boolean;
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
}

export class ClaudeRunner {
  constructor(private readonly config: Config) {}

  async run(opts: RunOptions): Promise<RunResult> {
    const abort = new AbortController();
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
    if (opts.enableAskHuman) {
      askHuman = createAskHuman(abort);
      options.mcpServers = { [askHuman.serverName]: askHuman.server };
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
      `[claude] ${label}: starting session (model ${this.config.model}, maxTurns ${opts.maxTurns ?? "default"}${wantsStructured ? ", structured output" : ""})`,
    );

    let sessionId: string | undefined;
    let text = "";
    let structuredOutput: unknown;
    let isError = false;
    let resultSubtype: string | undefined;
    let turns: number | undefined;

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
          if (message.subtype === "success") {
            text = message.result;
            structuredOutput = message.structured_output;
          }
        }
      }
    } catch (e) {
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
        };
      }
      // We aborted a wedged session on the stall timeout — report it as an
      // error result (not a thrown crash) so the caller can retry/route it.
      if (stalledOut && e instanceof AbortError) {
        clearInterval(heartbeat);
        return { text, sessionId, structuredOutput, isError: true, blocked: false, question: undefined };
      }
      throw e;
    } finally {
      clearInterval(heartbeat);
    }

    console.log(
      `[claude] ${label}: finished — subtype=${resultSubtype ?? "none"}, turns=${turns ?? "?"}, ` +
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
    };
  }
}
