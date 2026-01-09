/**
 * Testing-MCP Adapter (MCP Server)
 * Runs as stdio MCP server and communicates with daemon via RPC
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";

import { BridgeClient, createBridgeClient } from "./bridgeClient.js";
import { FileEditor } from "./fileEditor.js";
import {
  MCPTools,
  GetCurrentStateSchema,
  FinalizeTestSchema,
  ExecuteTestStepSchema,
} from "./tools.js";
import { VERSION } from "../shared/constants.js";

/**
 * MCP Adapter Server
 */
export class MCPAdapter {
  private server: Server;
  private bridgeClient: BridgeClient | null = null;
  private fileEditor: FileEditor;
  private mcpTools: MCPTools | null = null;

  constructor() {
    this.server = new Server(
      {
        name: "testing-mcp",
        version: VERSION,
      },
      {
        capabilities: {
          tools: {},
          logging: {},
        },
      }
    );

    this.fileEditor = new FileEditor();
    this.setupHandlers();
    this.setupErrorHandling();
  }

  /**
   * Initialize connection to daemon
   */
  private async ensureBridgeConnection(): Promise<MCPTools> {
    if (!this.bridgeClient) {
      console.error("[testing-mcp:adapter] Connecting to daemon...");
      this.bridgeClient = await createBridgeClient({
        autoStartDaemon: true,
      });
      this.mcpTools = new MCPTools(this.bridgeClient, this.fileEditor);
      console.error("[testing-mcp:adapter] Connected to daemon");
    }
    return this.mcpTools!;
  }

  /**
   * Setup MCP request handlers
   */
  private setupHandlers() {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: this.getToolDefinitions(),
      };
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        // Ensure we're connected to daemon
        const tools = await this.ensureBridgeConnection();

        switch (name) {
          case "get_current_test_state": {
            const params = GetCurrentStateSchema.parse(args);
            const result = await tools.getCurrentTestState(params);
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(result, null, 2),
                },
              ],
            };
          }

          case "finalize_test": {
            const params = FinalizeTestSchema.parse(args);
            const result = await tools.finalizeTest(params);
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(result, null, 2),
                },
              ],
            };
          }

          case "list_active_tests": {
            const result = await tools.listActiveTests();
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(result, null, 2),
                },
              ],
            };
          }

          case "get_generated_code": {
            const testFile = (args as any)?.testFile;
            if (!testFile) {
              throw new Error("testFile parameter is required");
            }
            const result = await tools.getGeneratedCode(testFile);
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(result, null, 2),
                },
              ],
            };
          }

          case "execute_test_step": {
            const params = ExecuteTestStepSchema.parse(args);
            const result = await tools.executeTestStep(params);
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(result, null, 2),
                },
              ],
            };
          }

          default:
            throw new Error(`Unknown tool: ${name}`);
        }
      } catch (error) {
        console.error(`[testing-mcp:adapter] Error handling tool call ${name}:`, error);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : "Unknown error",
              }),
            },
          ],
          isError: true,
        };
      }
    });
  }

  /**
   * Get tool definitions for MCP
   */
  private getToolDefinitions(): Tool[] {
    return [
      {
        name: "get_current_test_state",
        description:
          "Get the current state of a connected test, including DOM, snapshot, console logs, and available context APIs. The response includes 'availableContext' field which lists all APIs/variables that can be used in execute_test_step.",
        inputSchema: {
          type: "object",
          properties: {
            testFile: {
              type: "string",
              description: "Optional: specific test file path",
            },
            testName: {
              type: "string",
              description: "Optional: specific test name",
            },
          },
        },
      },
      {
        name: "finalize_test",
        description:
          "Finalize the test by removing connect() call and optionally cleaning up markers",
        inputSchema: {
          type: "object",
          properties: {
            testFile: {
              type: "string",
              description: "Path to the test file",
            },
            removeMarkers: {
              type: "boolean",
              description:
                "Whether to remove TESTING-MCP markers (default: true)",
              default: true,
            },
          },
          required: ["testFile"],
        },
      },
      {
        name: "list_active_tests",
        description: "List all currently connected test processes",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "get_generated_code",
        description: "Get all generated code blocks from a test file",
        inputSchema: {
          type: "object",
          properties: {
            testFile: {
              type: "string",
              description: "Path to the test file",
            },
          },
          required: ["testFile"],
        },
      },
      {
        name: "execute_test_step",
        description:
          "Execute code directly in the connected test client and get back the updated DOM state and console logs. IMPORTANT: Before using this tool, call get_current_test_state first to check the 'availableContext' field, which lists all available APIs/variables you can use in your code.",
        inputSchema: {
          type: "object",
          properties: {
            code: {
              type: "string",
              description:
                "The JavaScript/TypeScript code to execute in the test environment. You can use any APIs/variables listed in the 'availableContext' field from get_current_test_state (e.g., screen, fireEvent, waitFor, userEvent, etc.). The code should only reference variables that are available in availableContext.",
            },
            testFile: {
              type: "string",
              description:
                "Optional: specific test file (uses current if not provided)",
            },
            testName: {
              type: "string",
              description:
                "Optional: specific test name (uses current if not provided)",
            },
          },
          required: ["code"],
        },
      },
    ];
  }

  /**
   * Setup error handling
   */
  private setupErrorHandling() {
    process.on("SIGINT", async () => {
      console.error("\n[testing-mcp:adapter] Shutting down...");
      await this.shutdown();
      process.exit(0);
    });

    process.on("SIGTERM", async () => {
      console.error("\n[testing-mcp:adapter] Shutting down...");
      await this.shutdown();
      process.exit(0);
    });
  }

  /**
   * Start the adapter
   */
  async start() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error(`[testing-mcp:adapter] MCP adapter started (v${VERSION})`);
    console.error("[testing-mcp:adapter] Ready to accept tool calls");
  }

  /**
   * Shutdown the adapter
   */
  async shutdown() {
    try {
      if (this.bridgeClient) {
        this.bridgeClient.disconnect();
      }
      await this.server.close();
      console.error("[testing-mcp:adapter] Adapter shut down successfully");
    } catch (error) {
      console.error("[testing-mcp:adapter] Error during shutdown:", error);
    }
  }
}

/**
 * Run the MCP adapter
 */
export async function runAdapter(): Promise<void> {
  const adapter = new MCPAdapter();
  await adapter.start();
}

// Exports
export { BridgeClient, createBridgeClient } from "./bridgeClient.js";
export { FileEditor } from "./fileEditor.js";
export { MCPTools } from "./tools.js";
