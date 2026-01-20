/**
 * Shared Constants for Testing-MCP
 * Used by both daemon and adapter
 */

import * as path from "path";
import * as os from "os";

/**
 * Get the base directory for testing-mcp data files
 */
export function getDataDir(): string {
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return path.join(localAppData, "testing-mcp");
  }
  return path.join(os.homedir(), ".testing-mcp");
}

/**
 * Registry file path - contains daemon connection info
 */
export function getRegistryPath(): string {
  return path.join(getDataDir(), "bridge.json");
}

/**
 * Lock file path - used for preventing concurrent daemon starts
 */
export function getLockPath(): string {
  return path.join(getDataDir(), "bridge.lock");
}

/**
 * Protocol version for compatibility checking
 */
export const PROTOCOL_VERSION = 1;

/**
 * Timeouts
 */
export const DAEMON_START_TIMEOUT = 10000; // 10 seconds to wait for daemon to start
export const RPC_CALL_TIMEOUT = 35000; // 35 seconds for RPC calls (slightly more than execute timeout)
export const EXECUTE_TIMEOUT = 30000; // 30 seconds for code execution
export const LOCK_STALE_TIMEOUT = 30000; // 30 seconds before considering a lock stale

/**
 * RPC method names
 */
export const RPC_METHODS = {
  // Connection management
  GET_CURRENT_STATE: "getCurrentState",
  LIST_CONNECTIONS: "listConnections",
  SEND_EXECUTE: "sendExecute",
  SEND_CLOSE: "sendClose",
  SEND_CONTINUE: "sendContinue",
  SEND_ERROR: "sendError",
  WAIT_FOR_READY: "waitForReady",

  // Daemon management
  PING: "ping",
  SHUTDOWN: "shutdown",
} as const;

/**
 * Version info
 */
export const VERSION = "0.4.0";
