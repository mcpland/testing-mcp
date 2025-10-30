/**
 * Server Side: Connection Manager
 * Manages WebSocket connections from test processes
 */

import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'crypto';
import type { TestState } from '../types/index.js';

export interface ConnectionInfo {
  ws: WebSocket;
  testFile: string;
  testName: string;
  state: TestState;
  connectedAt: number;
  sessionId: string; // Unique identifier for this connection session
  callbacks: Set<StateUpdateCallback>; // Track callbacks associated with this connection
  executeResolvers: Map<string, (state: TestState) => void>; // Track pending execute requests
}

export type StateUpdateCallback = (state: TestState) => void;

export class ConnectionManager {
  private server: WebSocketServer;
  private connections = new Map<string, ConnectionInfo>();
  private stateUpdateCallbacks: StateUpdateCallback[] = [];
  // Track which callbacks are waiting for which test (for pending connections)
  private pendingCallbacks = new Map<StateUpdateCallback, { testFile: string; testName: string }>();

  constructor(port: number = 3001) {
    this.server = new WebSocketServer({ port });
    this.server.on('connection', this.handleConnection);
    console.error(`[testing-mcp] WebSocket server listening on port ${port}`);
  }

  /**
   * Handle new WebSocket connection
   */
  private handleConnection = (ws: WebSocket) => {
    console.error('[testing-mcp] New connection received');

    ws.on('message', (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString());
        
        if (message.type === 'ready') {
          this.handleReadyMessage(ws, message.data);
        } else if (message.type === 'executed') {
          this.handleExecutedMessage(ws, message.data);
        }
      } catch (error) {
        console.error('[testing-mcp] Failed to parse message:', error);
        ws.send(JSON.stringify({
          type: 'error',
          data: { message: 'Invalid message format' }
        }));
      }
    });

    ws.on('error', (error) => {
      console.error('[testing-mcp] WebSocket error:', error);
    });

    ws.on('close', () => {
      console.error('[testing-mcp] Connection closed');
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
      sessionId
    };
    
    // Store connection info
    const connectionInfo: ConnectionInfo = {
      ws,
      testFile: state.testFile,
      testName: state.testName,
      state: stateWithSession,
      connectedAt: Date.now(),
      sessionId,
      callbacks: new Set(), // Initialize empty callback set
      executeResolvers: new Map() // Initialize empty execute resolvers map
    };
    
    this.connections.set(key, connectionInfo);
    
    console.error(`[testing-mcp] Test ready: ${state.testFile} - ${state.testName} [Session: ${sessionId}]`);
    
    // Send 'connected' message back to client with sessionId
    try {
      ws.send(JSON.stringify({
        type: 'connected',
        data: { sessionId }
      }));
      console.error(`[testing-mcp] Sent session ID to client: ${sessionId}`);
    } catch (error) {
      console.error('[testing-mcp] Failed to send connected message:', error);
    }
    
    // Notify listeners
    this.notifyStateUpdate(stateWithSession);
  }

  /**
   * Handle 'executed' message from test process
   */
  private handleExecutedMessage(ws: WebSocket, data: { executeId: string; state: TestState }) {
    // Find connection by WebSocket
    for (const [key, connection] of this.connections.entries()) {
      if (connection.ws === ws) {
        console.error(`[testing-mcp] Received executed result for ${key}, executeId: ${data.executeId}`);
        
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
        connection.ws.send(JSON.stringify({
          type: 'execute',
          data: { executeId, code }
        }));
        console.error(`[testing-mcp] Sent execute to ${key}, executeId: ${executeId}`);
      } catch (error) {
        clearTimeout(timeoutId);
        connection.executeResolvers.delete(executeId);
        reject(error);
      }
    });
  }

  /**
   * Send 'continue' message to test process (keeping connection alive)
   */
  public sendContinue(testFile: string, testName: string): boolean {
    const key = this.getConnectionKey(testFile, testName);
    const connection = this.connections.get(key);
    
    if (!connection) {
      console.error(`[testing-mcp] No connection found for ${key}`);
      return false;
    }

    try {
      connection.ws.send(JSON.stringify({ type: 'continue' }));
      console.error(`[testing-mcp] Sent continue to ${key} (keeping connection alive)`);
      return true;
    } catch (error) {
      console.error('[testing-mcp] Failed to send continue:', error);
      return false;
    }
  }

  /**
   * Send 'close' message to test process to release await connect()
   */
  public sendClose(testFile: string, testName: string): boolean {
    const key = this.getConnectionKey(testFile, testName);
    const connection = this.connections.get(key);
    
    if (!connection) {
      console.warn(`[testing-mcp] No connection found for ${key}`);
      return false;
    }

    try {
      connection.ws.send(JSON.stringify({ type: 'close' }));
      console.error(`[testing-mcp] Sent close to ${key}`);
      // Connection will be removed when WebSocket closes
      return true;
    } catch (error) {
      console.error('[testing-mcp] Failed to send close:', error);
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
      connection.ws.send(JSON.stringify({
        type: 'error',
        data: { message: error }
      }));
      return true;
    } catch (err) {
      console.error('[testing-mcp] Failed to send error:', err);
      return false;
    }
  }

  /**
   * Get current test state
   */
  public getCurrentState(testFile?: string, testName?: string): TestState | null {
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

    // Wait for connection
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        // Clean up callback on timeout
        if (callback) {
          const index = this.stateUpdateCallbacks.indexOf(callback);
          if (index !== -1) {
            this.stateUpdateCallbacks.splice(index, 1);
          }
          this.pendingCallbacks.delete(callback);
        }
        reject(new Error(`Timeout waiting for test: ${key}`));
      }, timeout);

      const callback: StateUpdateCallback = (state: TestState) => {
        if (state.testFile === testFile && state.testName === testName) {
          clearTimeout(timeoutId);
          
          // Remove from global callbacks
          this.stateUpdateCallbacks.splice(
            this.stateUpdateCallbacks.indexOf(callback),
            1
          );
          
          // Remove from pending callbacks
          this.pendingCallbacks.delete(callback);
          
          // Add to connection-specific callbacks for cleanup
          const connection = this.connections.get(key);
          if (connection) {
            connection.callbacks.add(callback);
          }
          
          resolve(state);
        }
      };

      this.stateUpdateCallbacks.push(callback);
      // Track as pending until connection is established
      this.pendingCallbacks.set(callback, { testFile, testName });
    });
  }

  /**
   * Wait for a new session (reconnection with different session ID)
   * This is useful when code is inserted and we need to wait for the test to re-run
   */
  public async waitForNewSession(
    testFile: string,
    testName: string,
    currentSessionId: string,
    timeout: number = 60000
  ): Promise<TestState> {
    const key = this.getConnectionKey(testFile, testName);
    
    console.error(`[testing-mcp] Waiting for new session (current: ${currentSessionId})...`);
    
    // Wait for a new connection with different session ID
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        // Clean up callback on timeout
        if (callback) {
          const index = this.stateUpdateCallbacks.indexOf(callback);
          if (index !== -1) {
            this.stateUpdateCallbacks.splice(index, 1);
          }
          this.pendingCallbacks.delete(callback);
        }
        reject(new Error(`Timeout waiting for new session: ${key} (waited ${timeout}ms)`));
      }, timeout);

      const callback: StateUpdateCallback = (state: TestState) => {
        // Check if this is the right test AND has a different session ID
        if (
          state.testFile === testFile &&
          state.testName === testName &&
          state.sessionId &&
          state.sessionId !== currentSessionId
        ) {
          clearTimeout(timeoutId);
          
          console.error(`[testing-mcp] New session detected: ${state.sessionId} (previous: ${currentSessionId})`);
          console.error(`[testing-mcp] New DOM length: ${state.dom?.length || 0} chars`);
          console.error(`[testing-mcp] Console logs: ${state.consoleLogs?.length || 0} entries`);
          
          // Remove from global callbacks
          const index = this.stateUpdateCallbacks.indexOf(callback);
          if (index !== -1) {
            this.stateUpdateCallbacks.splice(index, 1);
          }
          
          // Remove from pending callbacks
          this.pendingCallbacks.delete(callback);
          
          // Add to connection-specific callbacks for cleanup
          const connection = this.connections.get(key);
          if (connection) {
            connection.callbacks.add(callback);
          }
          
          resolve(state);
        }
      };

      this.stateUpdateCallbacks.push(callback);
      // Track as pending until new connection is established
      this.pendingCallbacks.set(callback, { testFile, testName });
    });
  }

  /**
   * Register callback for state updates
   */
  public onStateUpdate(callback: StateUpdateCallback): () => void {
    this.stateUpdateCallbacks.push(callback);
    
    // Return unsubscribe function
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
        console.error('[testing-mcp] Error in state update callback:', error);
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
        console.error(`[testing-mcp] Removed connection: ${key}`);
        
        // Clean up any pending callbacks for this test
        // This prevents memory leaks and unexpected state reads
        this.cleanupCallbacksForTest(connection.testFile, connection.testName);
        break;
      }
    }
  }

  /**
   * Clean up state update callbacks for a specific test
   * This should be called when a connection is closed
   */
  private cleanupCallbacksForTest(testFile: string, testName: string): void {
    const key = this.getConnectionKey(testFile, testName);
    const connection = this.connections.get(key);
    
    let cleanedCount = 0;
    
    // 1. Remove callbacks that were associated with the established connection
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
    
    // 2. Remove any pending callbacks for this test (e.g., from waitForReady)
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
        `[testing-mcp] Cleaned up ${cleanedCount} callback(s) for ${key}`
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
   * Close all connections and shut down server
   */
  public async close(): Promise<void> {
    console.error('[testing-mcp] Closing all connections...');
    
    // Close all WebSocket connections
    for (const connection of this.connections.values()) {
      try {
        connection.ws.close();
      } catch (error) {
        console.error('[testing-mcp] Error closing connection:', error);
      }
    }
    
    // Clear all state
    this.connections.clear();
    this.stateUpdateCallbacks = [];
    this.pendingCallbacks.clear();
    
    console.error('[testing-mcp] Cleared all state (connections, callbacks, pending callbacks)');
    
    // Close WebSocket server
    return new Promise((resolve, reject) => {
      this.server.close((err) => {
        if (err) {
          reject(err);
        } else {
          console.error('[testing-mcp] Server closed');
          resolve();
        }
      });
    });
  }
}

