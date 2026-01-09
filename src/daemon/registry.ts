/**
 * Daemon Registry Module
 * Manages the registry file that stores daemon connection info
 * and provides file locking for preventing concurrent daemon starts
 */

import * as fs from "fs/promises";
import * as path from "path";
import { randomBytes } from "crypto";
import {
  getDataDir,
  getRegistryPath,
  getLockPath,
  LOCK_STALE_TIMEOUT,
  PROTOCOL_VERSION,
  VERSION,
} from "../shared/constants.js";
import type { RegistryInfo } from "../shared/types.js";

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
  const registry = await readRegistry();

  if (!registry) {
    return null;
  }

  // Verify the process is still running
  if (!isProcessRunning(registry.pid)) {
    console.error(`[testing-mcp] Daemon process ${registry.pid} is not running, cleaning up registry`);
    await deleteRegistry();
    return null;
  }

  return registry;
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
