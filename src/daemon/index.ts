/**
 * Testing-MCP Bridge Daemon
 * Singleton service that manages test WebSocket connections
 * and provides RPC interface for MCP adapters
 */

import { ConnectionManager } from "./connectionManager.js";
import { RPCServer } from "./rpcServer.js";
import {
  acquireLock,
  writeRegistry,
  deleteRegistry,
  generateToken,
  isDaemonRunning,
  type LockHandle,
} from "./registry.js";
import { VERSION } from "../shared/constants.js";

export interface DaemonOptions {
  wsPort?: number;
  rpcPort?: number;
  /** If true, runs in foreground mode (logs to stderr, doesn't detach) */
  foreground?: boolean;
}

export class Daemon {
  private connectionManager: ConnectionManager | null = null;
  private rpcServer: RPCServer | null = null;
  private lockHandle: LockHandle | null = null;
  private token: string | null = null;
  private startTime: number = 0;

  /**
   * Start the daemon
   */
  async start(options: DaemonOptions = {}): Promise<void> {
    const { foreground = true } = options;

    console.error(`[testing-mcp:daemon] Starting daemon v${VERSION}...`);

    // Check if daemon is already running
    const existingDaemon = await isDaemonRunning();
    if (existingDaemon) {
      console.error(
        `[testing-mcp:daemon] Daemon already running (pid: ${existingDaemon.pid}, ws: ${existingDaemon.wsPort}, rpc: ${existingDaemon.rpcPort})`
      );
      throw new Error("Daemon already running");
    }

    // Acquire lock to prevent concurrent daemon starts
    this.lockHandle = await acquireLock();
    if (!this.lockHandle) {
      throw new Error("Failed to acquire daemon lock. Another daemon may be starting.");
    }

    try {
      // Generate auth token
      this.token = generateToken();

      // Start WebSocket server for test connections
      // Use port 0 to let OS assign an available port
      const wsPort = options.wsPort ?? 0;
      this.connectionManager = new ConnectionManager(wsPort, this.token);
      await this.connectionManager.waitForListening();
      const actualWsPort = this.connectionManager.getPort();

      // Start RPC server for adapter connections
      const rpcPort = options.rpcPort ?? 0;
      this.rpcServer = await RPCServer.create({
        port: rpcPort,
        token: this.token,
        connectionManager: this.connectionManager,
      });
      const actualRpcPort = this.rpcServer.getPort();

      // Write registry file
      await writeRegistry(
        {
          pid: process.pid,
          wsPort: actualWsPort,
          rpcPort: actualRpcPort,
        },
        this.token
      );

      this.startTime = Date.now();

      console.error(`[testing-mcp:daemon] Daemon started successfully`);
      console.error(`[testing-mcp:daemon]   PID: ${process.pid}`);
      console.error(`[testing-mcp:daemon]   WebSocket port: ${actualWsPort}`);
      console.error(`[testing-mcp:daemon]   RPC port: ${actualRpcPort}`);
      console.error(`[testing-mcp:daemon]   Token: ${this.token.substring(0, 8)}...`);

      // Setup shutdown handlers
      this.setupShutdownHandlers();

      if (foreground) {
        // Keep running in foreground
        console.error("[testing-mcp:daemon] Running in foreground mode. Press Ctrl+C to stop.");
      }
    } catch (error) {
      // Cleanup on error
      await this.cleanup();
      throw error;
    }
  }

  /**
   * Setup signal handlers for graceful shutdown
   */
  private setupShutdownHandlers(): void {
    const shutdown = async (signal: string) => {
      console.error(`\n[testing-mcp:daemon] Received ${signal}, shutting down...`);
      await this.stop();
      process.exit(0);
    };

    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));

    // Handle uncaught errors
    process.on("uncaughtException", async (error) => {
      console.error("[testing-mcp:daemon] Uncaught exception:", error);
      await this.stop();
      process.exit(1);
    });

    process.on("unhandledRejection", async (reason) => {
      console.error("[testing-mcp:daemon] Unhandled rejection:", reason);
      await this.stop();
      process.exit(1);
    });
  }

  /**
   * Stop the daemon
   */
  async stop(): Promise<void> {
    console.error("[testing-mcp:daemon] Stopping daemon...");
    await this.cleanup();
    console.error("[testing-mcp:daemon] Daemon stopped");
  }

  /**
   * Cleanup resources
   */
  private async cleanup(): Promise<void> {
    // Close RPC server
    if (this.rpcServer) {
      try {
        await this.rpcServer.close();
      } catch (error) {
        console.error("[testing-mcp:daemon] Error closing RPC server:", error);
      }
      this.rpcServer = null;
    }

    // Close connection manager
    if (this.connectionManager) {
      try {
        await this.connectionManager.close();
      } catch (error) {
        console.error("[testing-mcp:daemon] Error closing connection manager:", error);
      }
      this.connectionManager = null;
    }

    // Delete registry file
    await deleteRegistry();

    // Release lock
    if (this.lockHandle) {
      try {
        await this.lockHandle.release();
      } catch (error) {
        console.error("[testing-mcp:daemon] Error releasing lock:", error);
      }
      this.lockHandle = null;
    }
  }

  /**
   * Get daemon status
   */
  getStatus(): {
    running: boolean;
    uptime: number;
    wsPort: number | null;
    rpcPort: number | null;
    connections: number;
    adapters: number;
  } {
    return {
      running: this.connectionManager !== null,
      uptime: this.startTime > 0 ? Date.now() - this.startTime : 0,
      wsPort: this.connectionManager?.getPort() ?? null,
      rpcPort: this.rpcServer?.getPort() ?? null,
      connections: this.connectionManager?.getConnectionCount() ?? 0,
      adapters: this.rpcServer?.getClientCount() ?? 0,
    };
  }
}

/**
 * Main entry point for running daemon as standalone process
 */
export async function runDaemon(options: DaemonOptions = {}): Promise<void> {
  const daemon = new Daemon();
  await daemon.start(options);

  // Keep process alive
  await new Promise(() => {
    // Never resolves - daemon runs until signal
  });
}

// Export for testing
export { ConnectionManager } from "./connectionManager.js";
export { RPCServer } from "./rpcServer.js";
export * from "./registry.js";
