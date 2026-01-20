/**
 * Agent Integration Tests with Mocked LLM
 *
 * These tests verify the full agent loop:
 * 1. tools/list - Get available tools from MCP server
 * 2. LLM decides to call a tool (mocked)
 * 3. tools/call - Execute tool on MCP server
 * 4. Feed tool result back to LLM
 * 5. LLM produces final answer
 *
 * Uses InMemoryTransport for fast, process-free testing
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import {
  runAgent,
  ScriptedLLM,
  toolUseResponse,
  textResponse,
  type LLMResponse,
} from "../src/agent/index.js";

/**
 * Create a mock MCP server for testing
 * Simulates testing-mcp tools without needing a real daemon
 */
function createMockServer() {
  // Track tool calls for assertions
  const toolCallHistory: Array<{ name: string; args: Record<string, unknown> }> = [];

  // Mock test state
  let mockTestState = {
    testFile: "/tests/App.test.tsx",
    testName: "renders correctly",
    dom: "<div>Hello World</div>",
    snapshot: "<html><body><div>Hello World</div></body></html>",
    consoleLogs: [] as string[],
    sessionId: "mock-session-123",
    availableContext: ["screen", "fireEvent", "waitFor"],
  };

  const server = new Server(
    { name: "testing-mcp-mock", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  // List tools handler
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "get_current_test_state",
        description: "Get the current state of a connected test",
        inputSchema: {
          type: "object",
          properties: {
            testFile: { type: "string" },
            testName: { type: "string" },
          },
        },
      },
      {
        name: "execute_test_step",
        description: "Execute code in the test environment",
        inputSchema: {
          type: "object",
          properties: {
            code: { type: "string" },
          },
          required: ["code"],
        },
      },
      {
        name: "list_active_tests",
        description: "List all active test connections",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "finalize_test",
        description: "Finalize the test and clean up",
        inputSchema: {
          type: "object",
          properties: {
            testFile: { type: "string" },
            removeMarkers: { type: "boolean" },
          },
          required: ["testFile"],
        },
      },
    ],
  }));

  // Call tool handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const typedArgs = (args ?? {}) as Record<string, unknown>;

    // Record the call
    toolCallHistory.push({ name, args: typedArgs });

    switch (name) {
      case "get_current_test_state":
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                newState: mockTestState,
              }),
            },
          ],
        };

      case "execute_test_step": {
        const code = typedArgs.code as string;

        // Simulate code execution by modifying DOM based on simple patterns
        if (code.includes("click")) {
          mockTestState = {
            ...mockTestState,
            dom: "<div>Button Clicked!</div>",
            consoleLogs: [...mockTestState.consoleLogs, "Button click executed"],
          };
        } else if (code.includes("type") || code.includes("input")) {
          mockTestState = {
            ...mockTestState,
            dom: '<input value="typed text" />',
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                message: "Code executed successfully",
                newState: mockTestState,
              }),
            },
          ],
        };
      }

      case "list_active_tests":
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                newState: {
                  tests: [
                    {
                      testFile: mockTestState.testFile,
                      testName: mockTestState.testName,
                      sessionId: mockTestState.sessionId,
                    },
                  ],
                },
              }),
            },
          ],
        };

      case "finalize_test":
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                message: `Test finalized: ${typedArgs.testFile}`,
              }),
            },
          ],
        };

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  });

  return {
    server,
    toolCallHistory,
    getMockState: () => mockTestState,
    setMockState: (state: Partial<typeof mockTestState>) => {
      mockTestState = { ...mockTestState, ...state };
    },
  };
}

describe("Agent Integration Tests (LLM Mocked)", () => {
  let client: Client;
  let mockServer: ReturnType<typeof createMockServer>;
  let clientTransport: InMemoryTransport;
  let serverTransport: InMemoryTransport;

  beforeEach(async () => {
    // Create linked transport pair
    [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    // Setup mock server
    mockServer = createMockServer();
    await mockServer.server.connect(serverTransport);

    // Setup client
    client = new Client(
      { name: "test-agent", version: "1.0.0" },
      { capabilities: {} }
    );
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await mockServer.server.close();
  });

  describe("Basic Tool Calling", () => {
    it("should call get_current_test_state and return result", async () => {
      const llm = new ScriptedLLM([
        // First: LLM decides to get current state
        toolUseResponse("get_current_test_state", {}),
        // Then: LLM produces final text
        textResponse("The current test shows 'Hello World' in the DOM."),
      ]);

      const result = await runAgent({
        client,
        llm,
        query: "What is the current test state?",
      });

      // Verify tool was called
      expect(mockServer.toolCallHistory).toHaveLength(1);
      expect(mockServer.toolCallHistory[0].name).toBe("get_current_test_state");

      // Verify output
      expect(result.output).toContain("Hello World");

      // Verify tool calls recorded
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0].name).toBe("get_current_test_state");
    });

    it("should execute test step and observe DOM changes", async () => {
      const llm = new ScriptedLLM([
        // LLM decides to click a button
        toolUseResponse("execute_test_step", {
          code: 'fireEvent.click(screen.getByRole("button"))',
        }),
        // LLM reports the result
        textResponse("I clicked the button and the DOM now shows 'Button Clicked!'."),
      ]);

      const result = await runAgent({
        client,
        llm,
        query: "Click the button",
      });

      // Verify execute was called with correct code
      expect(mockServer.toolCallHistory).toHaveLength(1);
      expect(mockServer.toolCallHistory[0]).toEqual({
        name: "execute_test_step",
        args: { code: 'fireEvent.click(screen.getByRole("button"))' },
      });

      // Verify DOM was updated
      expect(mockServer.getMockState().dom).toContain("Button Clicked!");

      // Verify output
      expect(result.output).toContain("Button Clicked!");
    });

    it("should list active tests", async () => {
      const llm = new ScriptedLLM([
        toolUseResponse("list_active_tests", {}),
        textResponse("There is 1 active test: App.test.tsx"),
      ]);

      const result = await runAgent({
        client,
        llm,
        query: "List all active tests",
      });

      expect(mockServer.toolCallHistory[0].name).toBe("list_active_tests");
      expect(result.output).toContain("App.test.tsx");
    });
  });

  describe("Multi-Tool Workflows", () => {
    it("should chain multiple tool calls (get state, execute, finalize)", async () => {
      const llm = new ScriptedLLM([
        // 1. Get current state
        toolUseResponse("get_current_test_state", {}, "call-1"),
        // 2. Execute a test step
        toolUseResponse("execute_test_step", {
          code: 'fireEvent.click(screen.getByText("Submit"))',
        }, "call-2"),
        // 3. Finalize the test
        toolUseResponse("finalize_test", {
          testFile: "/tests/App.test.tsx",
          removeMarkers: true,
        }, "call-3"),
        // 4. Final response
        textResponse("Test completed: clicked Submit and finalized the test."),
      ]);

      const result = await runAgent({
        client,
        llm,
        query: "Run the complete test flow",
      });

      // Verify all tools were called in order
      expect(mockServer.toolCallHistory).toHaveLength(3);
      expect(mockServer.toolCallHistory.map((c) => c.name)).toEqual([
        "get_current_test_state",
        "execute_test_step",
        "finalize_test",
      ]);

      // Verify tool call records
      expect(result.toolCalls).toHaveLength(3);
      expect(result.toolCalls[2].args).toEqual({
        testFile: "/tests/App.test.tsx",
        removeMarkers: true,
      });
    });

    it("should handle tool call with specific testFile/testName params", async () => {
      const llm = new ScriptedLLM([
        toolUseResponse("get_current_test_state", {
          testFile: "/tests/specific.test.tsx",
          testName: "specific test",
        }),
        textResponse("Got state for specific test."),
      ]);

      await runAgent({
        client,
        llm,
        query: "Get state for specific test",
      });

      expect(mockServer.toolCallHistory[0].args).toEqual({
        testFile: "/tests/specific.test.tsx",
        testName: "specific test",
      });
    });
  });

  describe("Edge Cases", () => {
    it("should handle LLM returning only text (no tool calls)", async () => {
      const llm = new ScriptedLLM([
        textResponse("I don't need to call any tools to answer this."),
      ]);

      const result = await runAgent({
        client,
        llm,
        query: "What is 2+2?",
      });

      expect(mockServer.toolCallHistory).toHaveLength(0);
      expect(result.toolCalls).toHaveLength(0);
      expect(result.output).toContain("I don't need to call any tools");
    });

    it("should respect maxIterations limit", async () => {
      // Create an LLM that always wants to call tools (infinite loop scenario)
      const responses: LLMResponse[] = [];
      for (let i = 0; i < 20; i++) {
        responses.push(toolUseResponse("get_current_test_state", {}, `call-${i}`));
      }
      responses.push(textResponse("Finally done"));

      const llm = new ScriptedLLM(responses);

      const result = await runAgent({
        client,
        llm,
        query: "Loop forever",
        maxIterations: 5,
      });

      // Should stop after 5 iterations even though LLM wants more
      expect(result.toolCalls.length).toBeLessThanOrEqual(5);
      expect(llm.getCallCount()).toBe(5);
    });

    it("should track full message history", async () => {
      const llm = new ScriptedLLM([
        toolUseResponse("list_active_tests", {}),
        textResponse("Found 1 test."),
      ]);

      const result = await runAgent({
        client,
        llm,
        query: "List tests",
      });

      // Should have: user query, assistant tool_use, user tool_result, assistant text
      expect(result.messages.length).toBeGreaterThanOrEqual(3);
      expect(result.messages[0]).toEqual({
        role: "user",
        content: "List tests",
      });
    });
  });

  describe("Tool Discovery", () => {
    it("should receive all available tools from server", async () => {
      // Use a custom LLM that captures the tools
      let receivedTools: unknown[] = [];

      const capturingLLM = {
        async create({ tools }: { tools: unknown[] }) {
          receivedTools = tools;
          return { content: [{ type: "text" as const, text: "Done" }] };
        },
      };

      await runAgent({
        client,
        llm: capturingLLM,
        query: "Test",
      });

      // Verify all expected tools are available
      const toolNames = receivedTools.map((t: any) => t.name);
      expect(toolNames).toContain("get_current_test_state");
      expect(toolNames).toContain("execute_test_step");
      expect(toolNames).toContain("list_active_tests");
      expect(toolNames).toContain("finalize_test");
    });
  });

  describe("ScriptedLLM Behavior", () => {
    it("should throw when script is exhausted", async () => {
      const llm = new ScriptedLLM([
        textResponse("Only one response"),
      ]);

      // First call works
      await llm.create({ messages: [], tools: [] });

      // Second call should throw
      await expect(llm.create({ messages: [], tools: [] })).rejects.toThrow(
        "ScriptedLLM: No more responses"
      );
    });

    it("should track call count correctly", async () => {
      const llm = new ScriptedLLM([
        textResponse("One"),
        textResponse("Two"),
        textResponse("Three"),
      ]);

      expect(llm.getCallCount()).toBe(0);

      await llm.create({ messages: [], tools: [] });
      expect(llm.getCallCount()).toBe(1);

      await llm.create({ messages: [], tools: [] });
      expect(llm.getCallCount()).toBe(2);
    });

    it("should reset properly", async () => {
      const llm = new ScriptedLLM([
        textResponse("Response"),
      ]);

      await llm.create({ messages: [], tools: [] });
      expect(llm.getCallCount()).toBe(1);

      llm.reset();
      expect(llm.getCallCount()).toBe(0);

      // Should be able to call again after reset
      const result = await llm.create({ messages: [], tools: [] });
      expect(result.content[0]).toEqual({ type: "text", text: "Response" });
    });
  });
});
