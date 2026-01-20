/**
 * Agent Module for Testing-MCP
 * Provides LLM interface abstraction and agent loop implementation
 * for integration testing with mocked LLMs
 */

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  CallToolResultSchema,
  ListToolsResultSchema,
} from "@modelcontextprotocol/sdk/types.js";

/**
 * Tool specification from MCP server
 */
export interface ToolSpec {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/**
 * LLM response content types (compatible with Anthropic/OpenAI formats)
 */
export type LLMContent =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

/**
 * LLM response structure
 */
export interface LLMResponse {
  content: LLMContent[];
  stopReason?: "end_turn" | "tool_use" | "max_tokens";
}

/**
 * Message in the conversation
 */
export interface Message {
  role: "user" | "assistant";
  content: string | LLMContent[];
}

/**
 * LLM interface - implement this to use different LLM providers
 */
export interface LLM {
  /**
   * Create a completion from the LLM
   * @param args - Messages and available tools
   * @returns LLM response with content
   */
  create(args: {
    messages: Message[];
    tools: ToolSpec[];
  }): Promise<LLMResponse>;
}

/**
 * Tool call record for testing assertions
 */
export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
  result: unknown;
}

/**
 * Agent run result
 */
export interface AgentResult {
  /** Final text output from the agent */
  output: string;
  /** All tool calls made during the run */
  toolCalls: ToolCall[];
  /** Full message history */
  messages: Message[];
}

/**
 * Run an agent loop with the given MCP client and LLM
 *
 * This implements the standard agent loop:
 * 1. Get available tools from MCP server
 * 2. Send query to LLM with tools
 * 3. If LLM returns tool_use, call the tool via MCP
 * 4. Feed tool result back to LLM
 * 5. Repeat until LLM returns only text (or max iterations)
 *
 * @param params - Agent parameters
 * @returns Agent result with output and tool calls
 */
export async function runAgent(params: {
  client: Client;
  llm: LLM;
  query: string;
  maxIterations?: number;
}): Promise<AgentResult> {
  const { client, llm, query, maxIterations = 10 } = params;

  // 1. Get available tools from MCP server
  const toolsResp = await client.request(
    { method: "tools/list" },
    ListToolsResultSchema
  );

  const tools: ToolSpec[] = toolsResp.tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema as Record<string, unknown>,
  }));

  // 2. Initialize conversation
  const messages: Message[] = [{ role: "user", content: query }];
  const toolCalls: ToolCall[] = [];
  const finalText: string[] = [];

  // 3. Agent loop
  let iterations = 0;

  while (iterations < maxIterations) {
    iterations++;

    const response = await llm.create({ messages, tools });

    let hasToolUse = false;

    for (const content of response.content) {
      if (content.type === "text") {
        finalText.push(content.text);
        continue;
      }

      if (content.type === "tool_use") {
        hasToolUse = true;

        // Call tool via MCP
        const toolResult = await client.request(
          {
            method: "tools/call",
            params: {
              name: content.name,
              arguments: content.input,
            },
          },
          CallToolResultSchema
        );

        // Record tool call
        toolCalls.push({
          name: content.name,
          args: content.input,
          result: toolResult.content,
        });

        // Append assistant message with tool_use
        messages.push({
          role: "assistant",
          content: response.content,
        });

        // Append tool result as user message (Anthropic pattern)
        messages.push({
          role: "user",
          content: [
            {
              type: "tool_result" as any,
              tool_use_id: content.id,
              content: JSON.stringify(toolResult.content),
            },
          ] as any,
        });

        // Continue to next iteration to let LLM process tool result
        break;
      }
    }

    // If no tool use, we're done
    if (!hasToolUse) {
      break;
    }
  }

  return {
    output: finalText.join("\n"),
    toolCalls,
    messages,
  };
}

/**
 * Scripted LLM for testing
 * Returns pre-defined responses in sequence
 */
export class ScriptedLLM implements LLM {
  private responses: LLMResponse[];
  private currentIndex = 0;

  constructor(responses: LLMResponse[]) {
    this.responses = responses;
  }

  async create(): Promise<LLMResponse> {
    if (this.currentIndex >= this.responses.length) {
      throw new Error(
        `ScriptedLLM: No more responses (called ${this.currentIndex + 1} times, ` +
        `but only ${this.responses.length} responses provided)`
      );
    }

    return this.responses[this.currentIndex++];
  }

  /**
   * Reset the script to start from the beginning
   */
  reset(): void {
    this.currentIndex = 0;
  }

  /**
   * Get the number of responses that have been used
   */
  getCallCount(): number {
    return this.currentIndex;
  }
}

/**
 * Helper to create a tool_use response
 */
export function toolUseResponse(
  name: string,
  input: Record<string, unknown>,
  id: string = `tool_${Date.now()}`
): LLMResponse {
  return {
    content: [{ type: "tool_use", id, name, input }],
    stopReason: "tool_use",
  };
}

/**
 * Helper to create a text response
 */
export function textResponse(text: string): LLMResponse {
  return {
    content: [{ type: "text", text }],
    stopReason: "end_turn",
  };
}
