import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

/**
 * The human-in-the-loop channel.
 *
 * We expose a single MCP tool, `ask_human`, to the agent. When the agent calls
 * it, we record the question and immediately abort the session — the
 * orchestrator then posts the question as a GitHub issue comment and parks the
 * case until a human replies (see pipeline.ts). The session is resumed later
 * with the human's answer.
 *
 * Aborting on call (rather than letting the model keep going) means we don't
 * pay for further turns once the agent has decided it is blocked.
 */

export interface AskHumanHandle {
  serverName: string;
  server: ReturnType<typeof createSdkMcpServer>;
  /** Fully-qualified tool name, for allowedTools. */
  toolName: string;
  wasAsked(): boolean;
  question(): string | undefined;
}

export function createAskHuman(abort: AbortController): AskHumanHandle {
  let asked = false;
  let question: string | undefined;
  const serverName = "human";

  const askTool = tool(
    "ask_human",
    "Ask a human maintainer one specific question when you are genuinely blocked " +
      "and cannot proceed without information only a human can provide (ambiguous " +
      "requirements, a product decision, or missing access/credentials). Use this " +
      "sparingly — you are expected to work autonomously. After calling it, stop: " +
      "the conversation pauses until a human replies.",
    { question: z.string().describe("The single, specific question to ask the human.") },
    async (args: { question: string }) => {
      asked = true;
      question = args.question;
      abort.abort();
      return {
        content: [
          {
            type: "text" as const,
            text: "Question recorded. Stopping now; the conversation will resume once a human replies.",
          },
        ],
      };
    },
  );

  const server = createSdkMcpServer({
    name: serverName,
    version: "1.0.0",
    tools: [askTool],
  });

  return {
    serverName,
    server,
    toolName: `mcp__${serverName}__ask_human`,
    wasAsked: () => asked,
    question: () => question,
  };
}
