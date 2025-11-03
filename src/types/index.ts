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
  port?: number;
  timeout?: number;
  waitForAsync?: boolean;
  filePath?: string;
  context?: ConnectContext;
  contextDescriptions?: Record<string, string>; // Optional descriptions for context keys
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
