/**
 * Shared Types for Testing-MCP Daemon/Adapter Architecture
 */

import type { TestState } from "../types/index.js";

/**
 * Registry file content - written by daemon, read by adapters and clients
 */
export interface RegistryInfo {
  /** Daemon process ID */
  pid: number;
  /** WebSocket port for test client connections */
  wsPort: number;
  /** RPC port for adapter connections */
  rpcPort: number;
  /** Authentication token */
  token: string;
  /** When daemon started */
  startedAt: string;
  /** Daemon version */
  version: string;
  /** Protocol version for compatibility */
  protocol: number;
}

/**
 * RPC request format
 */
export interface RPCRequest {
  id: string;
  method: string;
  params?: unknown;
  token: string;
}

/**
 * RPC response format
 */
export interface RPCResponse {
  id: string;
  success: boolean;
  result?: unknown;
  error?: string;
}

/**
 * Connection info exposed via RPC
 */
export interface ConnectionInfoDTO {
  testFile: string;
  testName: string;
  sessionId: string;
  connectedAt: number;
}

/**
 * RPC method parameter types
 */
export interface GetCurrentStateParams {
  testFile?: string;
  testName?: string;
}

export interface SendExecuteParams {
  testFile: string;
  testName: string;
  code: string;
  timeout?: number;
}

export interface SendCloseParams {
  testFile: string;
  testName: string;
}

export interface SendContinueParams {
  testFile: string;
  testName: string;
}

export interface SendErrorParams {
  testFile: string;
  testName: string;
  error: string;
}

export interface WaitForReadyParams {
  testFile: string;
  testName: string;
  timeout?: number;
}

/**
 * RPC method result types
 */
export interface GetCurrentStateResult {
  state: TestState | null;
}

export interface ListConnectionsResult {
  connections: ConnectionInfoDTO[];
}

export interface SendExecuteResult {
  state: TestState;
}

export interface SendCloseResult {
  success: boolean;
}

export interface SendContinueResult {
  success: boolean;
}

export interface SendErrorResult {
  success: boolean;
}

export interface WaitForReadyResult {
  state: TestState;
}

export interface PingResult {
  pong: true;
  version: string;
  uptime: number;
}

/**
 * Daemon status info
 */
export interface DaemonStatus {
  running: boolean;
  pid?: number;
  wsPort?: number;
  rpcPort?: number;
  version?: string;
  uptime?: number;
  connections?: number;
}
