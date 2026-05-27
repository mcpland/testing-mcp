/**
 * Daemon Registry Module
 * Manages the registry file that stores daemon connection info
 * and provides file locking for preventing concurrent daemon starts
 */

import * as fs from "fs/promises";
import * as path from "path";
import { randomBytes } from "crypto";
import WebSocket from "ws";
import {
  getDataDir,
  getRegistryPath,
  getLockPath,
  LOCK_STALE_TIMEOUT,
  PROTOCOL_VERSION,
  VERSION,
  RPC_METHODS,
} from "../shared/constants.js";
import type { RegistryInfo, RPCRequest, RPCResponse } from "../shared/types.js";

const DEFAULT_RPC_HEALTH_TIMEOUT_MS = 1000;

/**
 * Ensure the data directory exists
 */
export async function ensureDataDir(): Promise<void> {
  const dataDir = getDataDir();
  try {
    await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  } catch (error) {
    // Directory might already exist
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }
}

/**
 * Generate a secure random token
 */
export function generateToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Write the registry file with daemon info
 */
export async function writeRegistry(info: Omit<RegistryInfo, "token" | "startedAt" | "version" | "protocol">, token: string): Promise<void> {
  await ensureDataDir();

  const registry: RegistryInfo = {
    ...info,
    token,
    startedAt: new Date().toISOString(),
    version: VERSION,
    protocol: PROTOCOL_VERSION,
  };

  const registryPath = getRegistryPath();

  // Write atomically: write to temp file, then rename
  const tempPath = `${registryPath}.tmp.${process.pid}`;

  await fs.writeFile(tempPath, JSON.stringify(registry, null, 2), {
    encoding: "utf-8",
    mode: 0o600, // Only owner can read/write
  });

  await fs.rename(tempPath, registryPath);

  console.error(`[testing-mcp] Registry written to ${registryPath}`);
}

/**
 * Read the registry file
 * Returns null if file doesn't exist or is invalid
 */
export async function readRegistry(): Promise<RegistryInfo | null> {
  const registryPath = getRegistryPath();

  try {
    const content = await fs.readFile(registryPath, "utf-8");
    const registry = JSON.parse(content) as RegistryInfo;

    // Validate required fields
    if (
      typeof registry.pid !== "number" ||
      typeof registry.wsPort !== "number" ||
      typeof registry.rpcPort !== "number" ||
      typeof registry.token !== "string"
    ) {
      console.error("[testing-mcp] Invalid registry file format");
      return null;
    }

    return registry;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    console.error("[testing-mcp] Error reading registry:", error);
    return null;
  }
}

/**
 * Delete the registry file
 */
export async function deleteRegistry(): Promise<void> {
  const registryPath = getRegistryPath();

  try {
    await fs.unlink(registryPath);
    console.error("[testing-mcp] Registry deleted");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error("[testing-mcp] Error deleting registry:", error);
    }
  }
}

/**
 * Check if a process is running
 */
export function isProcessRunning(pid: number): boolean {
  try {
    // Sending signal 0 checks if process exists without killing it
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface DaemonHealth {
  healthy: boolean;
  pidAlive?: boolean;
  protocolCompatible?: boolean;
  reason?: string;
  registry: RegistryInfo | null;
  registryPath: string;
  rpcReachable?: boolean;
}

/**
 * Verify that the registry points to a daemon that can answer authenticated RPC.
 */
export async function pingDaemonRpc(
  registry: RegistryInfo,
  timeoutMs: number = DEFAULT_RPC_HEALTH_TIMEOUT_MS
): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${registry.rpcPort}`);
    let resolved = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const finish = (result: { ok: boolean; error?: string }) => {
      if (resolved) {
        return;
      }

      resolved = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      try {
        ws.close();
      } catch {
        // Ignore close errors during health checks.
      }
      resolve(result);
    };

    timeout = setTimeout(() => {
      finish({ ok: false, error: `RPC health check timed out after ${timeoutMs}ms` });
    }, timeoutMs);

    ws.on("open", () => {
      const request: RPCRequest = {
        id: "health-check",
        method: RPC_METHODS.PING,
        token: registry.token,
      };
      ws.send(JSON.stringify(request));
    });

    ws.on("message", (data: Buffer) => {
      try {
        const response = JSON.parse(data.toString()) as RPCResponse;
        if (response.id !== "health-check") {
          finish({ ok: false, error: "Unexpected RPC health check response id" });
          return;
        }

        if (!response.success) {
          finish({ ok: false, error: response.error || "RPC health check failed" });
          return;
        }

        finish({ ok: true });
      } catch (error) {
        finish({
          ok: false,
          error: error instanceof Error ? error.message : "Invalid RPC health check response",
        });
      }
    });

    ws.on("error", (error) => {
      finish({ ok: false, error: error.message });
    });

    ws.on("close", () => {
      finish({ ok: false, error: "RPC connection closed before health check completed" });
    });
  });
}

/**
 * Inspect the daemon registry and optionally clean up stale entries.
 */
export async function checkDaemonHealth(options: {
  cleanup?: boolean;
  rpcTimeoutMs?: number;
} = {}): Promise<DaemonHealth> {
  const registryPath = getRegistryPath();
  const registry = await readRegistry();
  const cleanup = options.cleanup === true;

  if (!registry) {
    return {
      healthy: false,
      reason: "registry_missing",
      registry,
      registryPath,
    };
  }

  const protocolCompatible = registry.protocol === PROTOCOL_VERSION;
  if (!protocolCompatible) {
    if (cleanup) {
      console.error(
        `[testing-mcp] Daemon protocol v${registry.protocol} is incompatible with expected v${PROTOCOL_VERSION}, cleaning up registry`
      );
      await deleteRegistry();
    }

    return {
      healthy: false,
      protocolCompatible,
      reason: "protocol_mismatch",
      registry,
      registryPath,
    };
  }

  const pidAlive = isProcessRunning(registry.pid);
  if (!pidAlive) {
    if (cleanup) {
      console.error(`[testing-mcp] Daemon process ${registry.pid} is not running, cleaning up registry`);
      await deleteRegistry();
    }

    return {
      healthy: false,
      pidAlive,
      protocolCompatible,
      reason: "process_not_running",
      registry,
      registryPath,
    };
  }

  const rpcHealth = await pingDaemonRpc(registry, options.rpcTimeoutMs);
  if (!rpcHealth.ok) {
    if (cleanup) {
      console.error(
        `[testing-mcp] Daemon RPC health check failed (${rpcHealth.error || "unknown error"}), cleaning up registry`
      );
      await deleteRegistry();
    }

    return {
      healthy: false,
      pidAlive,
      protocolCompatible,
      reason: rpcHealth.error || "rpc_unreachable",
      registry,
      registryPath,
      rpcReachable: false,
    };
  }

  return {
    healthy: true,
    pidAlive,
    protocolCompatible,
    registry,
    registryPath,
    rpcReachable: true,
  };
}

/**
 * Lock file handle for release
 */
export interface LockHandle {
  release: () => Promise<void>;
}

/**
 * Acquire an exclusive lock for daemon startup
 * Returns a handle to release the lock, or null if lock couldn't be acquired
 */
export async function acquireLock(): Promise<LockHandle | null> {
  await ensureDataDir();

  const lockPath = getLockPath();

  try {
    // Try to read existing lock file
    const existingLock = await tryReadLockFile(lockPath);

    if (existingLock) {
      const { pid, timestamp } = existingLock;
      const age = Date.now() - timestamp;

      // Check if lock is stale (old timestamp or dead process)
      if (age > LOCK_STALE_TIMEOUT || !isProcessRunning(pid)) {
        console.error(`[testing-mcp] Removing stale lock (pid: ${pid}, age: ${age}ms)`);
        await fs.unlink(lockPath).catch(() => {});
      } else {
        // Lock is held by another process
        console.error(`[testing-mcp] Lock held by process ${pid}`);
        return null;
      }
    }

    // Try to create lock file exclusively
    const lockContent = JSON.stringify({
      pid: process.pid,
      timestamp: Date.now(),
    });

    // Use O_CREAT | O_EXCL to fail if file exists
    const fd = await fs.open(lockPath, "wx");
    await fd.writeFile(lockContent, "utf-8");
    await fd.close();

    console.error(`[testing-mcp] Lock acquired (pid: ${process.pid})`);

    return {
      release: async () => {
        try {
          // Only delete if we still own it
          const currentLock = await tryReadLockFile(lockPath);
          if (currentLock?.pid === process.pid) {
            await fs.unlink(lockPath);
            console.error("[testing-mcp] Lock released");
          }
        } catch (error) {
          console.error("[testing-mcp] Error releasing lock:", error);
        }
      },
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      // Another process created the lock file
      console.error("[testing-mcp] Lock file already exists");
      return null;
    }
    throw error;
  }
}

/**
 * Try to read lock file content
 */
async function tryReadLockFile(
  lockPath: string
): Promise<{ pid: number; timestamp: number } | null> {
  try {
    const content = await fs.readFile(lockPath, "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Check if daemon is running by reading registry and verifying process
 */
export async function isDaemonRunning(): Promise<RegistryInfo | null> {
  const health = await checkDaemonHealth({
    cleanup: true,
  });

  return health.healthy ? health.registry : null;
}

/**
 * Wait for daemon to be ready (registry file appears with valid process)
 */
export async function waitForDaemonReady(timeout: number = 10000): Promise<RegistryInfo> {
  const startTime = Date.now();
  const pollInterval = 100; // Check every 100ms

  while (Date.now() - startTime < timeout) {
    const registry = await isDaemonRunning();
    if (registry) {
      return registry;
    }
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  throw new Error(`Timeout waiting for daemon to start (${timeout}ms)`);
}
