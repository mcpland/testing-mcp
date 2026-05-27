/**
 * Testing-MCP Core Types
 */

export type ConnectContext = Record<string, any>;

/**
 * Metadata describing a context key available during test execution
 */
export interface ContextMetadata {
  name: string;           // Context key name
  type: string;           // Basic type (e.g., 'function', 'object', 'string')
  description?: string;   // Optional human-readable description
  signature?: string;     // Optional function signature for functions
}

export interface ConnectOptions {
  /** Explicit daemon WebSocket port for the test client */
  port?: number;
  /** Explicit daemon token for the test client when using an explicit port */
  token?: string;
  /** Timeout for the entire connection session (default: 300000ms = 5 minutes) */
  timeout?: number;
  /** Wait for async operations before collecting state (default: true) */
  waitForAsync?: boolean;
  /** Test file path (auto-detected if not provided) */
  filePath?: string;
  /** Context objects to inject into code execution */
  context?: ConnectContext;
  /** Human-readable descriptions for context keys */
  contextDescriptions?: Record<string, string>;
  /** Timeout for waiting for daemon to start (default: 60000ms) */
  daemonWaitTimeout?: number;
}

export interface TestState {
  testFile: string;
  testName: string;
  dom: string;
  snapshot: string;
  consoleLogs: ConsoleLog[];
  errors?: string[];
  sessionId?: string; // Session ID for tracking reconnections
  availableContext?: ContextMetadata[]; // Available context keys and their metadata
}

export interface ConsoleLog {
  type: "log" | "warn" | "error" | "info" | "debug";
  args: any[];
  timestamp: number;
}

export interface WebSocketMessage {
  type:
    | "ready"
    | "connected"
    | "continue"
    | "close"
    | "error"
    | "state_update"
    | "execute"
    | "executed";
  data?: any;
}

export interface MCPToolResponse {
  success: boolean;
  message?: string;
  newState?: TestState;
  code?: string;
  error?: string;
}
