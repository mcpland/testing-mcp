/**
 * Testing-MCP Core Types
 */

export interface ConnectOptions {
  port?: number;
  timeout?: number;
  waitForAsync?: boolean;
  filePath?: string;
}

export interface TestState {
  testFile: string;
  testName: string;
  dom: string;
  snapshot: string;
  consoleLogs: ConsoleLog[];
  errors?: string[];
  sessionId?: string; // Session ID for tracking reconnections
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
