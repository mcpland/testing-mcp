/**
 * Bridge Client for MCP Adapter
 * Connects to the daemon and provides RPC communication
 */

import WebSocket from "ws";
import { randomUUID } from "crypto";
import { spawn, type ChildProcess } from "child_process";
import {
  RPC_METHODS,
  RPC_CALL_TIMEOUT,
  DAEMON_START_TIMEOUT,
} from "../shared/constants.js";
import {
  readRegistry,
  isDaemonRunning,
  waitForDaemonReady,
} from "../daemon/registry.js";
import type {
  RegistryInfo,
  RPCRequest,
  RPCResponse,
  GetCurrentStateParams,
  SendExecuteParams,
  SendCloseParams,
  SendContinueParams,
  SendErrorParams,
  WaitForReadyParams,
  GetCurrentStateResult,
  ListConnectionsResult,
  SendExecuteResult,
  SendCloseResult,
  SendContinueResult,
  SendErrorResult,
  WaitForReadyResult,
  PingResult,
} from "../shared/types.js";
import type { TestState } from "../types/index.js";

export interface BridgeClientOptions {
  /** If true, automatically start daemon if not running */
  autoStartDaemon?: boolean;
  /** Path to the daemon executable (defaults to current process) */
  daemonPath?: string;
}

export class BridgeClient {
  private ws: WebSocket | null = null;
  private registry: RegistryInfo | null = null;
  private pendingRequests = new Map<
    string,
    {
      resolve: (result: unknown) => void;
      reject: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  private connected = false;
  private connecting = false;
  private daemonProcess: ChildProcess | null = null;

  constructor(private options: BridgeClientOptions = {}) {}

  /**
   * Connect to the daemon
   */
  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }

    if (this.connecting) {
      // Wait for existing connection attempt
      await this.waitForConnection();
      return;
    }

    this.connecting = true;

    try {
      // Check if daemon is running
      this.registry = await isDaemonRunning();

      if (!this.registry) {
        if (this.options.autoStartDaemon !== false) {
          // Start daemon
          await this.startDaemon();
          // Wait for daemon to be ready
          this.registry = await waitForDaemonReady(DAEMON_START_TIMEOUT);
        } else {
          throw new Error("Daemon is not running. Start it with 'testing-mcp bridge'");
        }
      }

      // Connect to RPC server
      await this.connectWebSocket();

      this.connected = true;
      console.error(
        `[testing-mcp:adapter] Connected to daemon (ws: ${this.registry.wsPort}, rpc: ${this.registry.rpcPort})`
      );
    } finally {
      this.connecting = false;
    }
  }

  /**
   * Start the daemon process
   */
  private async startDaemon(): Promise<void> {
    console.error("[testing-mcp:adapter] Starting daemon...");

    // Use the same Node.js executable and module
    const execPath = process.execPath;
    const modulePath = this.options.daemonPath || process.argv[1];

    // Spawn daemon with 'bridge' subcommand
    this.daemonProcess = spawn(execPath, [modulePath, "bridge"], {
      detached: true,
      stdio: "ignore",
    });

    // Detach from parent process
    this.daemonProcess.unref();

    console.error(`[testing-mcp:adapter] Daemon process spawned (pid: ${this.daemonProcess.pid})`);
  }

  /**
   * Connect to daemon's WebSocket RPC server
   */
  private async connectWebSocket(): Promise<void> {
    if (!this.registry) {
      throw new Error("No registry available");
    }

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${this.registry!.rpcPort}`);

      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error("Connection timeout"));
      }, 5000);

      ws.on("open", () => {
        clearTimeout(timeout);
        this.ws = ws;
        this.setupMessageHandler();
        resolve();
      });

      ws.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }

  /**
   * Setup WebSocket message handler
   */
  private setupMessageHandler(): void {
    if (!this.ws) return;

    this.ws.on("message", (data: Buffer) => {
      try {
        const response = JSON.parse(data.toString()) as RPCResponse;
        const pending = this.pendingRequests.get(response.id);

        if (pending) {
          clearTimeout(pending.timeout);
          this.pendingRequests.delete(response.id);

          if (response.success) {
            pending.resolve(response.result);
          } else {
            pending.reject(new Error(response.error || "Unknown error"));
          }
        }
      } catch (error) {
        console.error("[testing-mcp:adapter] Error parsing response:", error);
      }
    });

    this.ws.on("close", () => {
      console.error("[testing-mcp:adapter] Disconnected from daemon");
      this.connected = false;
      this.ws = null;

      // Reject all pending requests
      for (const [id, pending] of this.pendingRequests) {
        clearTimeout(pending.timeout);
        pending.reject(new Error("Connection closed"));
      }
      this.pendingRequests.clear();
    });

    this.ws.on("error", (error) => {
      console.error("[testing-mcp:adapter] WebSocket error:", error);
    });
  }

  /**
   * Wait for connection to complete
   */
  private async waitForConnection(): Promise<void> {
    const maxWait = 10000;
    const start = Date.now();

    while (this.connecting && Date.now() - start < maxWait) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    if (!this.connected) {
      throw new Error("Connection failed");
    }
  }

  /**
   * Send RPC request and wait for response
   */
  private async rpc<T>(
    method: string,
    params?: unknown,
    timeout: number = RPC_CALL_TIMEOUT
  ): Promise<T> {
    if (!this.connected || !this.ws || !this.registry) {
      await this.connect();
    }

    if (!this.ws || !this.registry) {
      throw new Error("Not connected to daemon");
    }

    const id = randomUUID();
    const request: RPCRequest = {
      id,
      method,
      params,
      token: this.registry.token,
    };

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`RPC timeout for ${method} after ${timeout}ms`));
      }, timeout);

      this.pendingRequests.set(id, {
        resolve: resolve as (result: unknown) => void,
        reject,
        timeout: timeoutId,
      });

      this.ws!.send(JSON.stringify(request));
    });
  }

  /**
   * Ping the daemon
   */
  async ping(): Promise<PingResult> {
    return this.rpc<PingResult>(RPC_METHODS.PING);
  }

  /**
   * Get current test state
   */
  async getCurrentState(params: GetCurrentStateParams = {}): Promise<TestState | null> {
    const result = await this.rpc<GetCurrentStateResult>(
      RPC_METHODS.GET_CURRENT_STATE,
      params
    );
    return result.state;
  }

  /**
   * List all active connections
   */
  async listConnections(): Promise<ListConnectionsResult> {
    return this.rpc<ListConnectionsResult>(RPC_METHODS.LIST_CONNECTIONS);
  }

  /**
   * Execute code in a test
   */
  async sendExecute(params: SendExecuteParams): Promise<TestState> {
    const result = await this.rpc<SendExecuteResult>(
      RPC_METHODS.SEND_EXECUTE,
      params,
      params.timeout || RPC_CALL_TIMEOUT
    );
    return result.state;
  }

  /**
   * Send close signal to test
   */
  async sendClose(params: SendCloseParams): Promise<boolean> {
    const result = await this.rpc<SendCloseResult>(RPC_METHODS.SEND_CLOSE, params);
    return result.success;
  }

  /**
   * Send continue signal to test
   */
  async sendContinue(params: SendContinueParams): Promise<boolean> {
    const result = await this.rpc<SendContinueResult>(
      RPC_METHODS.SEND_CONTINUE,
      params
    );
    return result.success;
  }

  /**
   * Send error to test
   */
  async sendError(params: SendErrorParams): Promise<boolean> {
    const result = await this.rpc<SendErrorResult>(RPC_METHODS.SEND_ERROR, params);
    return result.success;
  }

  /**
   * Wait for test to be ready
   */
  async waitForReady(params: WaitForReadyParams): Promise<TestState> {
    const result = await this.rpc<WaitForReadyResult>(
      RPC_METHODS.WAIT_FOR_READY,
      params,
      params.timeout || 60000
    );
    return result.state;
  }

  /**
   * Request daemon shutdown
   */
  async shutdown(): Promise<void> {
    await this.rpc(RPC_METHODS.SHUTDOWN);
  }

  /**
   * Get the WebSocket port for test clients
   */
  getWsPort(): number | null {
    return this.registry?.wsPort ?? null;
  }

  /**
   * Check if connected to daemon
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Disconnect from daemon
   */
  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this.registry = null;
  }
}

/**
 * Create and connect a bridge client
 */
export async function createBridgeClient(
  options: BridgeClientOptions = {}
): Promise<BridgeClient> {
  const client = new BridgeClient(options);
  await client.connect();
  return client;
}
