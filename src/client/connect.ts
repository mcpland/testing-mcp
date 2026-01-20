/**
 * Client Side: connect() function
 * This function is called in test files to connect to the MCP Server
 */

import type {
  ConnectOptions,
  ConnectContext,
  TestState,
  ConsoleLog,
  ContextMetadata,
} from "../types/index.js";

// Static imports for Node.js built-in modules
// These must be static imports to work in Jest's VM sandbox environment
// Dynamic imports (await import()) fail in CommonJS modules running in Jest
import * as path from "path";
import * as os from "os";
import * as fsPromises from "fs/promises";

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
 * Get the registry file path
 */
function getRegistryPath(): string {
  // Determine registry path based on platform
  let dataDir: string;
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    dataDir = path.join(localAppData, "testing-mcp");
  } else {
    dataDir = path.join(os.homedir(), ".testing-mcp");
  }

  return path.join(dataDir, "bridge.json");
}

/**
 * Check if a process is running
 */
function isProcessRunning(pid: number): boolean {
  try {
    // Sending signal 0 checks if process exists without killing it
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Try to read the daemon registry file to get WebSocket port
 * This allows automatic port discovery without configuration
 */
async function tryReadRegistry(): Promise<{ wsPort: number; token?: string; pid?: number } | null> {
  try {
    const registryPath = getRegistryPath();
    const content = await fsPromises.readFile(registryPath, "utf-8");
    const registry = JSON.parse(content);

    if (typeof registry.wsPort === "number") {
      return {
        wsPort: registry.wsPort,
        token: registry.token,
        pid: registry.pid,
      };
    }

    return null;
  } catch {
    // Registry file doesn't exist or is invalid
    return null;
  }
}

/**
 * Wait for daemon to be ready (registry file appears with valid process)
 * Returns registry info when daemon is ready, or null if timeout
 */
async function waitForDaemon(timeout: number = 60000): Promise<{ wsPort: number; token?: string } | null> {
  const startTime = Date.now();
  const pollInterval = 500; // Check every 500ms

  console.log(`[testing-mcp] Waiting for daemon to be ready (timeout: ${timeout}ms)...`);

  while (Date.now() - startTime < timeout) {
    const registry = await tryReadRegistry();

    if (registry && registry.pid) {
      // Verify the process is still running
      if (isProcessRunning(registry.pid)) {
        console.log(`[testing-mcp] Daemon is ready (pid: ${registry.pid}, port: ${registry.wsPort})`);
        return {
          wsPort: registry.wsPort,
          token: registry.token,
        };
      } else {
        // Registry exists but process is dead, wait for it to be cleaned up
        console.log(`[testing-mcp] Daemon process ${registry.pid} is not running, waiting...`);
      }
    }

    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  return null;
}

/**
 * Resolve the WebSocket connection info
 * Uses auto-discovery from daemon registry file.
 *
 * @param waitTimeout Timeout for waiting for daemon (default: 60 seconds)
 */
async function resolveConnectionInfo(
  waitTimeout: number = 60000
): Promise<{ port: number; token?: string }> {
  // 1. Auto-discovery from registry file (primary method)
  const registry = await tryReadRegistry();
  if (registry && registry.pid && isProcessRunning(registry.pid)) {
    console.log(`[testing-mcp] Auto-discovered daemon on port ${registry.wsPort}`);
    return { port: registry.wsPort, token: registry.token };
  }

  // 2. Wait for daemon to be ready
  console.log("[testing-mcp] No daemon found, waiting for daemon to start...");
  console.log("[testing-mcp] Please start the MCP adapter (e.g., via Claude Desktop or Cursor)");

  const daemonInfo = await waitForDaemon(waitTimeout);
  if (daemonInfo) {
    return { port: daemonInfo.wsPort, token: daemonInfo.token };
  }

  // 3. Timeout - throw error
  throw new Error(
    `[testing-mcp] Timeout waiting for daemon. Please ensure the MCP adapter is running.\n` +
    `Hint: Start the adapter via Claude Desktop, Cursor, or run 'npx testing-mcp bridge' manually.`
  );
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
 *   await connect({
 *     context: { screen, fireEvent },
 *   });
 * });
 * ```
 */
export async function connect(options: ConnectOptions = {}): Promise<void> {
  process.env.TESTING_MCP_FILE =
    process.env.TESTING_MCP_FILE ?? options.filePath;
  // Check environment
  if (!process.env.TESTING_MCP) {
    console.log("[testing-mcp] Skipping in CI/non-dev environment");
    return;
  }

  const {
    timeout = 300000, // 5 minutes
    waitForAsync = true,
    context,
    contextDescriptions,
    daemonWaitTimeout = 60000, // 60 seconds to wait for daemon
  } = options;

  // Resolve connection info (with auto-discovery and waiting for daemon)
  // This will block until daemon is ready or timeout
  const connectionInfo = await resolveConnectionInfo(daemonWaitTimeout);
  const { port, token } = connectionInfo;

  // 1. Wait for all async operations to complete
  if (waitForAsync) {
    await waitForAsyncOperations();
  }

  // 2. Collect current state (including context metadata)
  const state = await collectCurrentState(context, contextDescriptions);

  // 3. Connect to MCP Server with retry
  await connectToServerWithRetry(port, timeout, state, context, contextDescriptions, token);
}

/**
 * Collect metadata about the context object
 * This includes type information and optional descriptions
 */
function collectContextMetadata(
  context?: ConnectContext,
  descriptions?: Record<string, string>
): ContextMetadata[] | undefined {
  if (!context || Object.keys(context).length === 0) {
    return undefined;
  }

  const metadata: ContextMetadata[] = [];

  for (const [key, value] of Object.entries(context)) {
    const baseType = typeof value;
    let signature: string | undefined;

    // Try to extract function signature for functions
    if (baseType === "function") {
      try {
        const fnString = value.toString();
        // Extract parameter list from function string
        const paramMatch = fnString.match(/\(([^)]*)\)/);
        if (paramMatch) {
          signature = `(${paramMatch[1]}) => ...`;
        }
      } catch {
        // Ignore errors in signature extraction
      }
    }

    metadata.push({
      name: key,
      type: baseType,
      description: descriptions?.[key],
      signature,
    });
  }

  return metadata;
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
async function collectCurrentState(
  context?: ConnectContext,
  contextDescriptions?: Record<string, string>
): Promise<TestState> {
  const testFile = getTestFile();
  const testName = getCurrentTestName();
  const availableContext = collectContextMetadata(context, contextDescriptions);

  // Check if we're in a browser-like environment
  if (typeof document !== "undefined") {
    return {
      testFile,
      testName,
      dom: document.body.innerHTML,
      snapshot: generateSnapshot(),
      consoleLogs: getConsoleLogs(),
      availableContext,
    };
  }

  // Fallback for non-DOM environment
  return {
    testFile,
    testName,
    dom: "",
    snapshot: "No DOM available",
    consoleLogs: [],
    availableContext,
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
  data: { executeId: string; code: string },
  injectedContext?: ConnectContext,
  contextDescriptions?: Record<string, string>
): Promise<void> {
  const { executeId, code } = data;

  console.log(
    `[testing-mcp] Executing code (executeId: ${executeId}):\n${code}`
  );

  try {
    // Check if we're in a DOM environment
    if (typeof document === "undefined") {
      throw new Error("Cannot execute code: no DOM environment available");
    }

    // Import testing-library if available
    const context: ConnectContext = {
      ...(injectedContext ?? {}),
    };

    // Ensure base browser globals are available if not injected
    if (typeof document !== "undefined" && context.document === undefined) {
      context.document = document;
    }

    if (typeof window !== "undefined" && context.window === undefined) {
      context.window = window;
    }

    if (context.console === undefined) {
      context.console = console;
    }

    // Execute the code in context
    // Using AsyncFunction to support await
    const AsyncFunction = Object.getPrototypeOf(
      async function () {}
    ).constructor;
    const executor = new AsyncFunction(...Object.keys(context), code);

    await executor(...Object.values(context));

    console.log("[testing-mcp] Code executed successfully");

    // Wait a bit for DOM updates
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Collect new state (including context metadata)
    const newState = await collectCurrentState(
      injectedContext,
      contextDescriptions
    );

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

    console.log(
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
            ...(await collectCurrentState(
              injectedContext,
              contextDescriptions
            )),
            errors: [error instanceof Error ? error.message : String(error)],
          },
        },
      })
    );
  }
}

/**
 * Connect to MCP Server with retry logic
 * Retries connection on failure with exponential backoff
 */
async function connectToServerWithRetry(
  port: number,
  timeout: number,
  state: TestState,
  injectedContext?: ConnectContext,
  contextDescriptions?: Record<string, string>,
  token?: string,
  maxRetries: number = 10,
  initialDelay: number = 1000
): Promise<void> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      await connectToServer(port, timeout, state, injectedContext, contextDescriptions, token);
      return; // Success
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Check if it's a connection error (daemon might not be ready yet)
      const isConnectionError =
        lastError.message.includes("ECONNREFUSED") ||
        lastError.message.includes("Connection refused") ||
        lastError.message.includes("connection failed") ||
        lastError.message.includes("WebSocket error event") ||
        lastError.message.includes("WebSocket connection failed") ||
        lastError.message.includes("connection closed unexpectedly");

      if (!isConnectionError) {
        // Not a connection error, don't retry
        throw lastError;
      }

      if (attempt < maxRetries - 1) {
        const delay = initialDelay * Math.pow(1.5, attempt);
        console.log(
          `[testing-mcp] Connection failed, retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${maxRetries})...`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError || new Error("Connection failed after all retries");
}

/**
 * Connect to MCP Server via WebSocket
 */
async function connectToServer(
  port: number,
  timeout: number,
  state: TestState,
  injectedContext?: ConnectContext,
  contextDescriptions?: Record<string, string>,
  token?: string
): Promise<void> {
  // Get the appropriate WebSocket implementation
  const WSImpl = await getWebSocketImpl();

  return new Promise((resolve, reject) => {
    // Build WebSocket URL with optional token
    let wsUrl = `ws://localhost:${port}`;
    if (token) {
      wsUrl += `?token=${encodeURIComponent(token)}`;
    }

    const ws = new WSImpl(wsUrl);
    let sessionId: string | undefined;
    let resolved = false; // Track if promise has been resolved/rejected

    const timeoutId = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      ws.close();
      reject(new Error(`Connection timeout after ${timeout}ms`));
    }, timeout);

    // Helper to handle both Node.js ws and browser WebSocket APIs
    const onOpen = () => {
      console.log("[testing-mcp] Connected to server");

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
          console.log(`[testing-mcp] Received session ID: ${sessionId}`);

          // Store session ID in process.env for potential future use
          if (sessionId) {
            process.env.TESTING_MCP_SESSION_ID = sessionId;
          }
        } else if (message.type === "continue") {
          // MCP Server tells us to continue
          // Keep connection alive - don't close yet
          console.log(
            "[testing-mcp] Received continue signal, keeping connection alive"
          );
        } else if (message.type === "execute") {
          // Execute code and send back result
          handleExecuteMessage(
            ws,
            message.data,
            injectedContext,
            contextDescriptions
          ).catch((error) => {
            console.error(
              "[testing-mcp] Failed to handle execute message:",
              error
            );
          });
        } else if (message.type === "close") {
          // Explicit close signal - finalize_test was called
          console.log(
            `[testing-mcp] Closing connection [Session: ${sessionId}]`
          );
          clearTimeout(timeoutId);

          // Clean up session ID
          delete process.env.TESTING_MCP_SESSION_ID;

          resolved = true;
          ws.close();
          resolve();
        } else if (message.type === "error") {
          clearTimeout(timeoutId);

          // Clean up session ID
          delete process.env.TESTING_MCP_SESSION_ID;

          resolved = true;
          ws.close();
          reject(new Error(message.data?.message || "Unknown error"));
        }
      } catch (error) {
        console.error("[testing-mcp] Failed to parse message:", error);
      }
    };

    const onError = (error: any) => {
      if (resolved) return;

      clearTimeout(timeoutId);

      // Clean up session ID
      delete process.env.TESTING_MCP_SESSION_ID;

      resolved = true;

      // Handle different error types:
      // - Node.js ws package: passes Error object directly
      // - Browser WebSocket: passes Event object with limited info
      let errorMessage: string;
      if (error instanceof Error) {
        errorMessage = error.message;
      } else if (error && typeof error === "object") {
        // Browser WebSocket Event - extract what we can
        if ("message" in error && typeof error.message === "string") {
          errorMessage = error.message;
        } else if ("type" in error) {
          errorMessage = `WebSocket ${error.type} event - connection failed to ws://localhost:${port}`;
        } else {
          errorMessage = `WebSocket connection failed to ws://localhost:${port}`;
        }
      } else {
        errorMessage = `WebSocket connection failed to ws://localhost:${port}`;
      }

      reject(new Error(errorMessage));
    };

    const onClose = () => {
      clearTimeout(timeoutId);

      // Clean up session ID
      delete process.env.TESTING_MCP_SESSION_ID;

      // If not already resolved, reject with connection closed error
      // This handles unexpected disconnections
      if (!resolved) {
        resolved = true;
        reject(new Error("WebSocket connection closed unexpectedly"));
      }
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
