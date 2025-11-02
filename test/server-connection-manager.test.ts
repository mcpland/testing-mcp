import { EventEmitter } from "events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const uuidCounter = { current: 0 };

class FakeWebSocket extends EventEmitter {
  public sentMessages: string[] = [];
  public closed = false;

  send(payload: string) {
    this.sentMessages.push(payload);
  }

  close() {
    this.closed = true;
    this.emit("close");
  }

  triggerMessage(message: unknown) {
    const buffer = Buffer.from(JSON.stringify(message));
    this.emit("message", buffer);
  }
}

class FakeWebSocketServer extends EventEmitter {
  static instances: FakeWebSocketServer[] = [];
  public closed = false;

  constructor() {
    super();
    FakeWebSocketServer.instances.push(this);
  }

  static reset() {
    this.instances.length = 0;
  }

  simulateConnection(ws: FakeWebSocket = new FakeWebSocket()): FakeWebSocket {
    this.emit("connection", ws);
    return ws;
  }

  close(callback?: (err?: Error) => void) {
    this.closed = true;
    callback?.();
  }
}

vi.mock("ws", () => ({
  WebSocketServer: FakeWebSocketServer,
  WebSocket: FakeWebSocket,
}));

vi.mock("crypto", () => ({
  randomUUID: () => `uuid-${++uuidCounter.current}`,
}));

describe("ConnectionManager", () => {
  beforeEach(() => {
    uuidCounter.current = 0;
    FakeWebSocketServer.reset();
    vi.resetModules();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  async function createManager() {
    const { ConnectionManager } = await import(
      "../src/server/connectionManager.ts"
    );
    const manager = new ConnectionManager(9000);
    const server = FakeWebSocketServer.instances.at(-1)!;
    return { manager, server };
  }

  function baseState() {
    return {
      testFile: "/tests/sample.test.tsx",
      testName: "renders component",
      dom: "<div>content</div>",
      snapshot: "<div>content</div>",
      consoleLogs: [],
    };
  }

  it("tracks connections and provides current state", async () => {
    const { manager, server } = await createManager();
    const ws = server.simulateConnection();

    const updates: unknown[] = [];
    const unsubscribe = manager.onStateUpdate((state) => {
      updates.push(state);
    });

    ws.triggerMessage({ type: "ready", data: baseState() });

    expect(manager.getActiveConnections()).toHaveLength(1);
    expect(manager.getCurrentState()).toMatchObject({
      testFile: "/tests/sample.test.tsx",
    });

    const explicit = manager.getCurrentState(
      "/tests/sample.test.tsx",
      "renders component",
    );
    expect(explicit?.sessionId).toBe("uuid-1");

    expect(updates).toHaveLength(1);
    unsubscribe();
  });

  it("waits for ready state and resolves with connection state", async () => {
    const { manager, server } = await createManager();
    const ws = server.simulateConnection();

    const waitPromise = manager.waitForReady(
      "/tests/sample.test.tsx",
      "renders component",
      500,
    );

    ws.triggerMessage({ type: "ready", data: baseState() });

    await expect(waitPromise).resolves.toMatchObject({
      sessionId: "uuid-1",
    });
  });

  it("sends execute commands and resolves with new state", async () => {
    const { manager, server } = await createManager();
    const ws = server.simulateConnection();

    ws.triggerMessage({ type: "ready", data: baseState() });

    const before = ws.sentMessages.length;
    const executePromise = manager.sendExecute(
      "/tests/sample.test.tsx",
      "renders component",
      "console.log('hello')",
      500,
    );

    expect(ws.sentMessages.length).toBe(before + 1);
    const executePayload = JSON.parse(ws.sentMessages.at(-1)!);
    expect(executePayload).toMatchObject({
      type: "execute",
      data: { code: "console.log('hello')" },
    });

    ws.triggerMessage({
      type: "executed",
      data: {
        executeId: executePayload.data.executeId,
        state: {
          ...baseState(),
          dom: "<div>new</div>",
        },
      },
    });

    await expect(executePromise).resolves.toMatchObject({
      dom: "<div>new</div>",
    });
  });

  it("returns false when sending continue or close to unknown connection", async () => {
    const { manager } = await createManager();
    expect(manager.sendContinue("no", "test")).toBe(false);
    expect(manager.sendClose("no", "test")).toBe(false);
    expect(manager.sendError("no", "test", "boom")).toBe(false);
  });

  it("sends control messages to active connections", async () => {
    const { manager, server } = await createManager();
    const ws = server.simulateConnection();

    ws.triggerMessage({ type: "ready", data: baseState() });

    const initialLength = ws.sentMessages.length;

    expect(
      manager.sendContinue("/tests/sample.test.tsx", "renders component"),
    ).toBe(true);
    expect(ws.sentMessages.length).toBe(initialLength + 1);
    expect(JSON.parse(ws.sentMessages.at(-1)!)).toMatchObject({
      type: "continue",
    });

    expect(
      manager.sendError("/tests/sample.test.tsx", "renders component", "oops"),
    ).toBe(true);
    expect(ws.sentMessages.length).toBe(initialLength + 2);
    expect(JSON.parse(ws.sentMessages.at(-1)!)).toMatchObject({
      type: "error",
    });

    expect(
      manager.sendClose("/tests/sample.test.tsx", "renders component"),
    ).toBe(true);
    expect(ws.sentMessages.length).toBe(initialLength + 3);
    expect(JSON.parse(ws.sentMessages.at(-1)!)).toMatchObject({
      type: "close",
    });
  });

  it("waits for a new session when reconnecting", async () => {
    const { manager, server } = await createManager();
    const first = server.simulateConnection();
    first.triggerMessage({ type: "ready", data: baseState() });

    const initialSession = manager.getCurrentState()?.sessionId!;

    const waitForNew = manager.waitForNewSession(
      "/tests/sample.test.tsx",
      "renders component",
      initialSession,
      500,
    );

    // Simulate reconnection with new WebSocket
    const second = server.simulateConnection();
    second.triggerMessage({ type: "ready", data: baseState() });

    const newState = await waitForNew;
    expect(newState.sessionId).toBe("uuid-2");
    expect(newState.sessionId).not.toBe(initialSession);
  });

  it("removes connections on close and cleans callbacks", async () => {
    const { manager, server } = await createManager();
    const ws = server.simulateConnection();

    ws.triggerMessage({ type: "ready", data: baseState() });

    expect(manager.getActiveConnections()).toHaveLength(1);
    ws.close();
    expect(manager.getActiveConnections()).toHaveLength(0);
  });

  it("closes all resources gracefully", async () => {
    const { manager, server } = await createManager();
    const ws = server.simulateConnection();
    ws.triggerMessage({ type: "ready", data: baseState() });

    await manager.close();
    expect(ws.closed).toBe(true);
    expect(server.closed).toBe(true);
    expect(manager.getActiveConnections()).toHaveLength(0);
  });

  it("throws when execute is requested without a connection", async () => {
    const { manager } = await createManager();
    await expect(
      manager.sendExecute("missing", "test", "code"),
    ).rejects.toThrow("No connection found for missing:test");
  });
});
