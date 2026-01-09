/**
 * Daemon Connection Manager
 * Manages WebSocket connections from test processes
 * Migrated from server/connectionManager.ts for daemon architecture
 */

import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "crypto";
import type { TestState } from "../types/index.js";

export interface ConnectionInfo {
  ws: WebSocket;
  testFile: string;
  testName: string;
  state: TestState;
  connectedAt: number;
  sessionId: string;
  callbacks: Set<StateUpdateCallback>;
  executeResolvers: Map<string, (state: TestState) => void>;
}

export type StateUpdateCallback = (state: TestState) => void;

export class ConnectionManager {
  private server: WebSocketServer;
  private connections = new Map<string, ConnectionInfo>();
  private stateUpdateCallbacks: StateUpdateCallback[] = [];
  private pendingCallbacks = new Map<
    StateUpdateCallback,
    { testFile: string; testName: string }
  >();
  private actualPort: number;
  private ready: Promise<void>;
  private resolveReady!: () => void;

  constructor(port: number = 0) {
    // Create a promise that resolves when server is listening
    this.ready = new Promise((resolve) => {
      this.resolveReady = resolve;
    });

    // Use port 0 for automatic port assignment
    this.server = new WebSocketServer({ port, host: "127.0.0.1" });
    this.server.on("connection", this.handleConnection);

    this.server.on("listening", () => {
      // Get the actual assigned port
      const address = this.server.address();
      this.actualPort = typeof address === "object" && address !== null
        ? address.port
        : port;
      console.error(`[testing-mcp:ws] WebSocket server listening on port ${this.actualPort}`);
      this.resolveReady();
    });

    // Set default port in case we need it before listening
    this.actualPort = port;
  }

  /**
   * Wait for the server to start listening
   */
  async waitForListening(): Promise<void> {
    await this.ready;
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
    console.error("[testing-mcp:ws] New test connection received");

    ws.on("message", (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString());

        if (message.type === "ready") {
          this.handleReadyMessage(ws, message.data);
        } else if (message.type === "executed") {
          this.handleExecutedMessage(ws, message.data);
        }
      } catch (error) {
        console.error("[testing-mcp:ws] Failed to parse message:", error);
        ws.send(
          JSON.stringify({
            type: "error",
            data: { message: "Invalid message format" },
          })
        );
      }
    });

    ws.on("error", (error) => {
      console.error("[testing-mcp:ws] WebSocket error:", error);
    });

    ws.on("close", () => {
      console.error("[testing-mcp:ws] Connection closed");
      this.removeConnectionByWebSocket(ws);
    });
  };

  /**
   * Handle 'ready' message from test process
   */
  private handleReadyMessage(ws: WebSocket, state: TestState) {
    const key = this.getConnectionKey(state.testFile, state.testName);

    // Generate unique session ID
    const sessionId = this.generateSessionId();

    // Add sessionId to state
    const stateWithSession: TestState = {
      ...state,
      sessionId,
    };

    // Store connection info
    const connectionInfo: ConnectionInfo = {
      ws,
      testFile: state.testFile,
      testName: state.testName,
      state: stateWithSession,
      connectedAt: Date.now(),
      sessionId,
      callbacks: new Set(),
      executeResolvers: new Map(),
    };

    this.connections.set(key, connectionInfo);

    console.error(
      `[testing-mcp:ws] Test ready: ${state.testFile} - ${state.testName} [Session: ${sessionId}]`
    );

    // Send 'connected' message back to client with sessionId
    try {
      ws.send(
        JSON.stringify({
          type: "connected",
          data: { sessionId },
        })
      );
      console.error(`[testing-mcp:ws] Sent session ID to client: ${sessionId}`);
    } catch (error) {
      console.error("[testing-mcp:ws] Failed to send connected message:", error);
    }

    // Notify listeners
    this.notifyStateUpdate(stateWithSession);
  }

  /**
   * Handle 'executed' message from test process
   */
  private handleExecutedMessage(
    ws: WebSocket,
    data: { executeId: string; state: TestState }
  ) {
    // Find connection by WebSocket
    for (const [key, connection] of this.connections.entries()) {
      if (connection.ws === ws) {
        console.error(
          `[testing-mcp:ws] Received executed result for ${key}, executeId: ${data.executeId}`
        );

        // Update connection state
        connection.state = data.state;

        // Resolve any pending execute request
        const resolver = connection.executeResolvers.get(data.executeId);
        if (resolver) {
          resolver(data.state);
          connection.executeResolvers.delete(data.executeId);
        }

        break;
      }
    }
  }

  /**
   * Send 'execute' message to test process and wait for result
   */
  public async sendExecute(
    testFile: string,
    testName: string,
    code: string,
    timeout: number = 30000
  ): Promise<TestState> {
    const key = this.getConnectionKey(testFile, testName);
    const connection = this.connections.get(key);

    if (!connection) {
      throw new Error(`No connection found for ${key}`);
    }

    // Generate unique execute ID
    const executeId = randomUUID();

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        connection.executeResolvers.delete(executeId);
        reject(new Error(`Execute timeout after ${timeout}ms`));
      }, timeout);

      // Store resolver
      connection.executeResolvers.set(executeId, (state: TestState) => {
        clearTimeout(timeoutId);
        resolve(state);
      });

      // Send execute message
      try {
        connection.ws.send(
          JSON.stringify({
            type: "execute",
            data: { executeId, code },
          })
        );
        console.error(
          `[testing-mcp:ws] Sent execute to ${key}, executeId: ${executeId}`
        );
      } catch (error) {
        clearTimeout(timeoutId);
        connection.executeResolvers.delete(executeId);
        reject(error);
      }
    });
  }

  /**
   * Send 'continue' message to test process
   */
  public sendContinue(testFile: string, testName: string): boolean {
    const key = this.getConnectionKey(testFile, testName);
    const connection = this.connections.get(key);

    if (!connection) {
      console.error(`[testing-mcp:ws] No connection found for ${key}`);
      return false;
    }

    try {
      connection.ws.send(JSON.stringify({ type: "continue" }));
      console.error(
        `[testing-mcp:ws] Sent continue to ${key} (keeping connection alive)`
      );
      return true;
    } catch (error) {
      console.error("[testing-mcp:ws] Failed to send continue:", error);
      return false;
    }
  }

  /**
   * Send 'close' message to test process
   */
  public sendClose(testFile: string, testName: string): boolean {
    const key = this.getConnectionKey(testFile, testName);
    const connection = this.connections.get(key);

    if (!connection) {
      console.warn(`[testing-mcp:ws] No connection found for ${key}`);
      return false;
    }

    try {
      connection.ws.send(JSON.stringify({ type: "close" }));
      console.error(`[testing-mcp:ws] Sent close to ${key}`);
      return true;
    } catch (error) {
      console.error("[testing-mcp:ws] Failed to send close:", error);
      return false;
    }
  }

  /**
   * Send error message to test process
   */
  public sendError(testFile: string, testName: string, error: string): boolean {
    const key = this.getConnectionKey(testFile, testName);
    const connection = this.connections.get(key);

    if (!connection) {
      return false;
    }

    try {
      connection.ws.send(
        JSON.stringify({
          type: "error",
          data: { message: error },
        })
      );
      return true;
    } catch (err) {
      console.error("[testing-mcp:ws] Failed to send error:", err);
      return false;
    }
  }

  /**
   * Get current test state
   */
  public getCurrentState(
    testFile?: string,
    testName?: string
  ): TestState | null {
    if (!testFile || !testName) {
      // Return the most recent connection's state
      const connections = Array.from(this.connections.values());
      if (connections.length === 0) {
        return null;
      }
      connections.sort((a, b) => b.connectedAt - a.connectedAt);
      return connections[0].state;
    }

    const key = this.getConnectionKey(testFile, testName);
    const connection = this.connections.get(key);
    return connection?.state || null;
  }

  /**
   * Get all active connections
   */
  public getActiveConnections(): ConnectionInfo[] {
    return Array.from(this.connections.values());
  }

  /**
   * Wait for a test to be ready
   */
  public async waitForReady(
    testFile: string,
    testName: string,
    timeout: number = 60000
  ): Promise<TestState> {
    const key = this.getConnectionKey(testFile, testName);

    // Check if already connected
    const existing = this.connections.get(key);
    if (existing) {
      return existing.state;
    }

    let callback: StateUpdateCallback | undefined;

    // Wait for connection
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        if (callback) {
          const index = this.stateUpdateCallbacks.indexOf(callback);
          if (index !== -1) {
            this.stateUpdateCallbacks.splice(index, 1);
          }
          this.pendingCallbacks.delete(callback);
        }
        reject(new Error(`Timeout waiting for test: ${key}`));
      }, timeout);

      callback = (state: TestState) => {
        if (state.testFile === testFile && state.testName === testName) {
          clearTimeout(timeoutId);

          this.stateUpdateCallbacks.splice(
            this.stateUpdateCallbacks.indexOf(callback!),
            1
          );

          this.pendingCallbacks.delete(callback!);

          const connection = this.connections.get(key);
          if (connection) {
            connection.callbacks.add(callback!);
          }

          resolve(state);
        }
      };

      this.stateUpdateCallbacks.push(callback);
      this.pendingCallbacks.set(callback, { testFile, testName });
    });
  }

  /**
   * Wait for a new session (reconnection with different session ID)
   */
  public async waitForNewSession(
    testFile: string,
    testName: string,
    currentSessionId: string,
    timeout: number = 60000
  ): Promise<TestState> {
    const key = this.getConnectionKey(testFile, testName);

    console.error(
      `[testing-mcp:ws] Waiting for new session (current: ${currentSessionId})...`
    );

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        if (callback) {
          const index = this.stateUpdateCallbacks.indexOf(callback);
          if (index !== -1) {
            this.stateUpdateCallbacks.splice(index, 1);
          }
          this.pendingCallbacks.delete(callback);
        }
        reject(
          new Error(
            `Timeout waiting for new session: ${key} (waited ${timeout}ms)`
          )
        );
      }, timeout);

      const callback: StateUpdateCallback = (state: TestState) => {
        if (
          state.testFile === testFile &&
          state.testName === testName &&
          state.sessionId &&
          state.sessionId !== currentSessionId
        ) {
          clearTimeout(timeoutId);

          console.error(
            `[testing-mcp:ws] New session detected: ${state.sessionId} (previous: ${currentSessionId})`
          );

          const index = this.stateUpdateCallbacks.indexOf(callback);
          if (index !== -1) {
            this.stateUpdateCallbacks.splice(index, 1);
          }

          this.pendingCallbacks.delete(callback);

          const connection = this.connections.get(key);
          if (connection) {
            connection.callbacks.add(callback);
          }

          resolve(state);
        }
      };

      this.stateUpdateCallbacks.push(callback);
      this.pendingCallbacks.set(callback, { testFile, testName });
    });
  }

  /**
   * Register callback for state updates
   */
  public onStateUpdate(callback: StateUpdateCallback): () => void {
    this.stateUpdateCallbacks.push(callback);

    return () => {
      const index = this.stateUpdateCallbacks.indexOf(callback);
      if (index !== -1) {
        this.stateUpdateCallbacks.splice(index, 1);
      }
    };
  }

  /**
   * Notify all listeners of state update
   */
  private notifyStateUpdate(state: TestState): void {
    for (const callback of this.stateUpdateCallbacks) {
      try {
        callback(state);
      } catch (error) {
        console.error("[testing-mcp:ws] Error in state update callback:", error);
      }
    }
  }

  /**
   * Remove connection by WebSocket instance
   */
  private removeConnectionByWebSocket(ws: WebSocket): void {
    for (const [key, connection] of this.connections.entries()) {
      if (connection.ws === ws) {
        this.connections.delete(key);
        console.error(`[testing-mcp:ws] Removed connection: ${key}`);
        this.cleanupCallbacksForTest(connection.testFile, connection.testName);
        break;
      }
    }
  }

  /**
   * Clean up state update callbacks for a specific test
   */
  private cleanupCallbacksForTest(testFile: string, testName: string): void {
    const key = this.getConnectionKey(testFile, testName);
    const connection = this.connections.get(key);

    let cleanedCount = 0;

    if (connection) {
      for (const callback of connection.callbacks) {
        const index = this.stateUpdateCallbacks.indexOf(callback);
        if (index !== -1) {
          this.stateUpdateCallbacks.splice(index, 1);
          cleanedCount++;
        }
      }
      connection.callbacks.clear();
    }

    const pendingToRemove: StateUpdateCallback[] = [];
    for (const [callback, info] of this.pendingCallbacks.entries()) {
      if (info.testFile === testFile && info.testName === testName) {
        pendingToRemove.push(callback);
      }
    }

    for (const callback of pendingToRemove) {
      const index = this.stateUpdateCallbacks.indexOf(callback);
      if (index !== -1) {
        this.stateUpdateCallbacks.splice(index, 1);
        cleanedCount++;
      }
      this.pendingCallbacks.delete(callback);
    }

    if (cleanedCount > 0) {
      console.error(
        `[testing-mcp:ws] Cleaned up ${cleanedCount} callback(s) for ${key}`
      );
    }
  }

  /**
   * Generate unique session ID
   */
  private generateSessionId(): string {
    return randomUUID();
  }

  /**
   * Generate connection key
   */
  private getConnectionKey(testFile: string, testName: string): string {
    return `${testFile}:${testName}`;
  }

  /**
   * Get the number of active connections
   */
  public getConnectionCount(): number {
    return this.connections.size;
  }

  /**
   * Close all connections and shut down server
   */
  public async close(): Promise<void> {
    console.error("[testing-mcp:ws] Closing all connections...");

    for (const connection of this.connections.values()) {
      try {
        connection.ws.close();
      } catch (error) {
        console.error("[testing-mcp:ws] Error closing connection:", error);
      }
    }

    this.connections.clear();
    this.stateUpdateCallbacks = [];
    this.pendingCallbacks.clear();

    console.error(
      "[testing-mcp:ws] Cleared all state"
    );

    return new Promise((resolve, reject) => {
      this.server.close((err) => {
        if (err) {
          reject(err);
        } else {
          console.error("[testing-mcp:ws] WebSocket server closed");
          resolve();
        }
      });
    });
  }
}
