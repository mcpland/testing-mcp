/**
 * Daemon RPC Server
 * Provides RPC interface for adapters to communicate with the daemon
 */

import { WebSocketServer, WebSocket } from "ws";
import { RPC_METHODS, RPC_CALL_TIMEOUT, VERSION } from "../shared/constants.js";
import type {
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
  ConnectionInfoDTO,
} from "../shared/types.js";
import type { ConnectionManager } from "./connectionManager.js";

export interface RPCServerOptions {
  port: number;
  token: string;
  connectionManager: ConnectionManager;
}

export class RPCServer {
  private server: WebSocketServer;
  private token: string;
  private connectionManager: ConnectionManager;
  private startTime: number;
  private clients = new Set<WebSocket>();
  private actualPort: number;

  private constructor(
    server: WebSocketServer,
    options: RPCServerOptions,
    actualPort: number
  ) {
    this.server = server;
    this.token = options.token;
    this.connectionManager = options.connectionManager;
    this.startTime = Date.now();
    this.actualPort = actualPort;

    this.server.on("connection", this.handleConnection);
    this.server.on("error", (error) => {
      console.error("[testing-mcp:rpc] Server error:", error);
    });

    console.error(`[testing-mcp:rpc] RPC server listening on port ${actualPort}`);
  }

  /**
   * Create an RPC server asynchronously
   */
  static async create(options: RPCServerOptions): Promise<RPCServer> {
    return new Promise((resolve, reject) => {
      const server = new WebSocketServer({
        port: options.port,
        host: "127.0.0.1",
      });

      server.on("listening", () => {
        const address = server.address();
        const actualPort = typeof address === "object" && address !== null
          ? address.port
          : options.port;
        resolve(new RPCServer(server, options, actualPort));
      });

      server.on("error", (error) => {
        reject(error);
      });
    });
  }

  /**
   * Get the actual port the server is listening on
   */
  getPort(): number {
    return this.actualPort;
  }

  /**
   * Handle new WebSocket connection
   */
  private handleConnection = (ws: WebSocket) => {
    console.error("[testing-mcp:rpc] New adapter connection");
    this.clients.add(ws);

    ws.on("message", async (data: Buffer) => {
      try {
        const request = JSON.parse(data.toString()) as RPCRequest;
        const response = await this.handleRequest(request);
        ws.send(JSON.stringify(response));
      } catch (error) {
        console.error("[testing-mcp:rpc] Error handling message:", error);
        const errorResponse: RPCResponse = {
          id: "unknown",
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
        ws.send(JSON.stringify(errorResponse));
      }
    });

    ws.on("error", (error) => {
      console.error("[testing-mcp:rpc] Client error:", error);
    });

    ws.on("close", () => {
      console.error("[testing-mcp:rpc] Adapter disconnected");
      this.clients.delete(ws);
    });
  };

  /**
   * Handle RPC request
   */
  private async handleRequest(request: RPCRequest): Promise<RPCResponse> {
    const { id, method, params, token } = request;

    // Validate token
    if (token !== this.token) {
      return {
        id,
        success: false,
        error: "Invalid token",
      };
    }

    try {
      const result = await this.executeMethod(method, params);
      return {
        id,
        success: true,
        result,
      };
    } catch (error) {
      return {
        id,
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Execute RPC method
   */
  private async executeMethod(
    method: string,
    params?: unknown
  ): Promise<unknown> {
    // Helper to safely cast params
    const p = params || {};
    switch (method) {
      case RPC_METHODS.PING: {
        const result: PingResult = {
          pong: true,
          version: VERSION,
          uptime: Date.now() - this.startTime,
        };
        return result;
      }

      case RPC_METHODS.GET_CURRENT_STATE: {
        const { testFile, testName } = p as unknown as GetCurrentStateParams;
        const state = this.connectionManager.getCurrentState(testFile, testName);
        const result: GetCurrentStateResult = { state };
        return result;
      }

      case RPC_METHODS.LIST_CONNECTIONS: {
        const connections = this.connectionManager.getActiveConnections();
        const result: ListConnectionsResult = {
          connections: connections.map((conn): ConnectionInfoDTO => ({
            testFile: conn.testFile,
            testName: conn.testName,
            sessionId: conn.sessionId,
            connectedAt: conn.connectedAt,
          })),
        };
        return result;
      }

      case RPC_METHODS.SEND_EXECUTE: {
        const { testFile, testName, code, timeout } = p as unknown as SendExecuteParams;
        if (!testFile || !testName || !code) {
          throw new Error("Missing required parameters: testFile, testName, code");
        }
        const state = await this.connectionManager.sendExecute(
          testFile,
          testName,
          code,
          timeout || RPC_CALL_TIMEOUT
        );
        const result: SendExecuteResult = { state };
        return result;
      }

      case RPC_METHODS.SEND_CLOSE: {
        const { testFile, testName } = p as unknown as SendCloseParams;
        if (!testFile || !testName) {
          throw new Error("Missing required parameters: testFile, testName");
        }
        const success = this.connectionManager.sendClose(testFile, testName);
        const result: SendCloseResult = { success };
        return result;
      }

      case RPC_METHODS.SEND_CONTINUE: {
        const { testFile, testName } = p as unknown as SendContinueParams;
        if (!testFile || !testName) {
          throw new Error("Missing required parameters: testFile, testName");
        }
        const success = this.connectionManager.sendContinue(testFile, testName);
        const result: SendContinueResult = { success };
        return result;
      }

      case RPC_METHODS.SEND_ERROR: {
        const { testFile, testName, error } = p as unknown as SendErrorParams;
        if (!testFile || !testName || !error) {
          throw new Error("Missing required parameters: testFile, testName, error");
        }
        const success = this.connectionManager.sendError(testFile, testName, error);
        const result: SendErrorResult = { success };
        return result;
      }

      case RPC_METHODS.WAIT_FOR_READY: {
        const { testFile, testName, timeout } = p as unknown as WaitForReadyParams;
        if (!testFile || !testName) {
          throw new Error("Missing required parameters: testFile, testName");
        }
        const state = await this.connectionManager.waitForReady(
          testFile,
          testName,
          timeout || 60000
        );
        const result: WaitForReadyResult = { state };
        return result;
      }

      case RPC_METHODS.SHUTDOWN: {
        console.error("[testing-mcp:rpc] Shutdown requested via RPC");
        // Schedule shutdown after response is sent
        setTimeout(() => {
          process.emit("SIGTERM", "SIGTERM");
        }, 100);
        return { acknowledged: true };
      }

      default:
        throw new Error(`Unknown method: ${method}`);
    }
  }

  /**
   * Get number of connected clients
   */
  getClientCount(): number {
    return this.clients.size;
  }

  /**
   * Close the RPC server
   */
  async close(): Promise<void> {
    console.error("[testing-mcp:rpc] Closing RPC server...");

    // Close all client connections
    for (const client of this.clients) {
      try {
        client.close();
      } catch (error) {
        console.error("[testing-mcp:rpc] Error closing client:", error);
      }
    }
    this.clients.clear();

    // Close the server
    return new Promise((resolve, reject) => {
      this.server.close((err) => {
        if (err) {
          reject(err);
        } else {
          console.error("[testing-mcp:rpc] RPC server closed");
          resolve();
        }
      });
    });
  }
}
