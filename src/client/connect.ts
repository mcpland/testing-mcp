/**
 * Client Side: connect() function
 * This function is called in test files to connect to the MCP Server
 */

import type { ConnectOptions, TestState, ConsoleLog } from "../types/index.js";

// Lazy-loaded WebSocket implementation
let WebSocketImpl: any = null;

/**
 * Get the appropriate WebSocket implementation for the current environment
 */
async function getWebSocketImpl(): Promise<any> {
  if (WebSocketImpl) {
    return WebSocketImpl;
  }

  if (typeof globalThis.WebSocket !== "undefined") {
    // Browser environment - use native WebSocket
    WebSocketImpl = globalThis.WebSocket;
  } else {
    // Node.js environment - use ws package
    try {
      const { default: WS } = await import("ws");
      WebSocketImpl = WS;
    } catch (error) {
      console.error("[testing-mcp] Failed to load ws package:", error);
      throw new Error("WebSocket not available in this environment");
    }
  }

  return WebSocketImpl;
}

/**
 * Main connect function that connects test to MCP Server
 *
 * Usage in test:
 * ```typescript
 * import { connect } from 'testing-mcp/client';
 *
 * test('login flow', async () => {
 *   render(<LoginForm />);
 *   await connect({ port: 3001 });
 * });
 * ```
 */
export async function connect(options: ConnectOptions = {}): Promise<void> {
  process.env.TESTING_MCP_FILE =
    process.env.TESTING_MCP_FILE ?? options.filePath;
  // Check environment - skip in CI or if not explicitly enabled
  if (!process.env.TESTING_MCP || process.env.CI) {
    console.error("[testing-mcp] Skipping in CI/non-dev environment");
    return;
  }

  const {
    port = 3001,
    timeout = 300000, // 5 minutes
    waitForAsync = true,
  } = options;

  try {
    // 1. Wait for all async operations to complete
    if (waitForAsync) {
      await waitForAsyncOperations();
    }

    // 2. Collect current state
    const state = await collectCurrentState();

    // 3. Connect to MCP Server
    await connectToServer(port, timeout, state);
  } catch (error) {
    console.error("[testing-mcp] Error:", error);
    // Don't fail the test if connection fails
    // (MCP Server might not be running)
  }
}

/**
 * Wait for pending async operations
 */
async function waitForAsyncOperations(): Promise<void> {
  // Check if we're in a DOM environment
  if (typeof document === "undefined") {
    return;
  }

  // Simple wait for microtasks to complete
  await new Promise((resolve) => setTimeout(resolve, 100));

  // TODO: More sophisticated waiting:
  // - Check for pending fetch requests
  // - Check for pending timers
  // - Check for pending animations
}

/**
 * Collect current test state
 */
async function collectCurrentState(): Promise<TestState> {
  const testFile = getTestFile();
  const testName = getCurrentTestName();

  // Check if we're in a browser-like environment
  if (typeof document !== "undefined") {
    return {
      testFile,
      testName,
      dom: document.body.innerHTML,
      snapshot: generateSnapshot(),
      consoleLogs: getConsoleLogs(),
    };
  }

  // Fallback for non-DOM environment
  return {
    testFile,
    testName,
    dom: "",
    snapshot: "No DOM available",
    consoleLogs: [],
  };
}

/**
 * Generate a human-readable snapshot of the DOM
 */
function generateSnapshot(): string {
  if (typeof document === "undefined") {
    return "No DOM available";
  }

  try {
    // Try to use @testing-library/dom's prettyDOM if available
    const { prettyDOM } = require("@testing-library/dom");
    return prettyDOM(document.body, undefined, { highlight: false }) || "";
  } catch {
    // Fallback to basic HTML representation
    return document.body.outerHTML;
  }
}

/**
 * Get collected console logs
 */
function getConsoleLogs(): ConsoleLog[] {
  // In a real implementation, we would intercept console methods
  // For now, return empty array
  // TODO: Implement console log collection
  return [];
}

/**
 * Get the current test file path
 */
function getTestFile(): string {
  // Try to get from environment or test runner context
  if (process.env.TESTING_MCP_FILE) {
    return process.env.TESTING_MCP_FILE;
  }

  // Try to get from stack trace
  try {
    const stack = new Error().stack || "";
    const lines = stack.split("\n");
    for (const line of lines) {
      if (line.includes(".test.") || line.includes(".spec.")) {
        const match = line.match(/\((.+\.test\.[jt]sx?)/);
        if (match) {
          return match[1];
        }
      }
    }
  } catch {
    // Ignore errors
  }

  return "unknown";
}

/**
 * Get the current test name
 */
function getCurrentTestName(): string {
  // Try to get from global test context (Jest/Vitest)
  if (typeof (global as any).expect !== "undefined") {
    const state = (global as any).expect?.getState?.();
    if (state?.currentTestName) {
      return state.currentTestName;
    }
  }

  return "unknown";
}

/**
 * Handle 'execute' message from server
 */
async function handleExecuteMessage(
  ws: any,
  data: { executeId: string; code: string }
): Promise<void> {
  const { executeId, code } = data;

  console.error(
    `[testing-mcp] Executing code (executeId: ${executeId}):\n${code}`
  );

  try {
    // Check if we're in a DOM environment
    if (typeof document === "undefined") {
      throw new Error("Cannot execute code: no DOM environment available");
    }

    // Import testing-library if available
    let screen: any;
    let userEvent: any;
    let fireEvent: any;

    try {
      const testingLibrary = require("@testing-library/react");
      screen = testingLibrary.screen;
      fireEvent = testingLibrary.fireEvent;
    } catch {
      console.error("[testing-mcp] @testing-library/react not available");
    }

    try {
      const userEventLib = require("@testing-library/user-event");
      userEvent = userEventLib.default || userEventLib;
    } catch {
      console.error("[testing-mcp] @testing-library/user-event not available");
    }

    // Create execution context with testing-library utilities
    const context = {
      screen,
      userEvent,
      fireEvent,
      document,
      window,
      console,
    };

    // Execute the code in context
    // Using AsyncFunction to support await
    const AsyncFunction = Object.getPrototypeOf(
      async function () {}
    ).constructor;
    const executor = new AsyncFunction(...Object.keys(context), code);

    await executor(...Object.values(context));

    console.error("[testing-mcp] Code executed successfully");

    // Wait a bit for DOM updates
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Collect new state
    const newState = await collectCurrentState();

    // Send executed response back to server
    ws.send(
      JSON.stringify({
        type: "executed",
        data: {
          executeId,
          state: newState,
        },
      })
    );

    console.error(
      `[testing-mcp] Sent executed response (executeId: ${executeId})`
    );
  } catch (error) {
    console.error("[testing-mcp] Error executing code:", error);

    // Send error response
    ws.send(
      JSON.stringify({
        type: "executed",
        data: {
          executeId,
          state: {
            ...(await collectCurrentState()),
            errors: [error instanceof Error ? error.message : String(error)],
          },
        },
      })
    );
  }
}

/**
 * Connect to MCP Server via WebSocket
 */
async function connectToServer(
  port: number,
  timeout: number,
  state: TestState
): Promise<void> {
  // Get the appropriate WebSocket implementation
  const WSImpl = await getWebSocketImpl();

  return new Promise((resolve, reject) => {
    const ws = new WSImpl(`ws://localhost:${port}`);
    let sessionId: string | undefined;

    const timeoutId = setTimeout(() => {
      ws.close();
      reject(new Error(`Connection timeout after ${timeout}ms`));
    }, timeout);

    // Helper to handle both Node.js ws and browser WebSocket APIs
    const onOpen = () => {
      console.error("[testing-mcp] Connected to server");

      // Send initial state
      ws.send(
        JSON.stringify({
          type: "ready",
          data: state,
        })
      );
    };

    const onMessage = (event: any) => {
      try {
        // Handle both ws (data) and browser WebSocket (event.data)
        const dataStr =
          typeof event === "string"
            ? event
            : event.data
            ? event.data.toString()
            : event.toString();
        const message = JSON.parse(dataStr);

        if (message.type === "connected") {
          // Server sends us the session ID
          sessionId = message.data?.sessionId;
          console.error(`[testing-mcp] Received session ID: ${sessionId}`);

          // Store session ID in process.env for potential future use
          if (sessionId) {
            process.env.TESTING_MCP_SESSION_ID = sessionId;
          }
        } else if (message.type === "continue") {
          // MCP Server tells us to continue
          // Keep connection alive - don't close yet
          console.error(
            "[testing-mcp] Received continue signal, keeping connection alive"
          );
        } else if (message.type === "execute") {
          // Execute code and send back result
          handleExecuteMessage(ws, message.data).catch((error) => {
            console.error(
              "[testing-mcp] Failed to handle execute message:",
              error
            );
          });
        } else if (message.type === "close") {
          // Explicit close signal - finalize_test was called
          console.error(
            `[testing-mcp] Closing connection [Session: ${sessionId}]`
          );
          clearTimeout(timeoutId);

          // Clean up session ID
          delete process.env.TESTING_MCP_SESSION_ID;

          ws.close();
          resolve();
        } else if (message.type === "error") {
          clearTimeout(timeoutId);

          // Clean up session ID
          delete process.env.TESTING_MCP_SESSION_ID;

          ws.close();
          reject(new Error(message.data?.message || "Unknown error"));
        }
      } catch (error) {
        console.error("[testing-mcp] Failed to parse message:", error);
      }
    };

    const onError = (error: any) => {
      clearTimeout(timeoutId);

      // Clean up session ID
      delete process.env.TESTING_MCP_SESSION_ID;

      reject(error);
    };

    const onClose = () => {
      clearTimeout(timeoutId);

      // Clean up session ID
      delete process.env.TESTING_MCP_SESSION_ID;
    };

    // Set up event listeners based on WebSocket type
    if ("on" in ws && typeof ws.on === "function") {
      // Node.js ws package
      ws.on("open", onOpen);
      ws.on("message", onMessage);
      ws.on("error", onError);
      ws.on("close", onClose);
    } else {
      // Browser WebSocket
      ws.addEventListener("open", onOpen);
      ws.addEventListener("message", onMessage);
      ws.addEventListener("error", onError);
      ws.addEventListener("close", onClose);
    }
  });
}
