import { EventEmitter } from "events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

  constructor(private readonly options: { port: number }) {
    super();
    FakeWebSocketServer.instances.push(this);
    queueMicrotask(() => this.emit("listening"));
  }

  static reset() {
    this.instances.length = 0;
  }

  address() {
    return {
      port: this.options.port || 12345,
    };
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

describe("RPCServer", () => {
  beforeEach(() => {
    FakeWebSocketServer.reset();
    vi.resetModules();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns the shared package version from ping", async () => {
    const { RPCServer } = await import("../src/daemon/rpcServer.ts");
    const { RPC_METHODS, VERSION } = await import("../src/shared/constants.ts");

    const server = await RPCServer.create({
      port: 0,
      token: "secret-token",
      connectionManager: {} as any,
    });
    const fakeServer = FakeWebSocketServer.instances.at(-1)!;
    const ws = fakeServer.simulateConnection();

    ws.triggerMessage({
      id: "ping-1",
      method: RPC_METHODS.PING,
      token: "secret-token",
    });

    await vi.waitFor(() => {
      expect(ws.sentMessages).toHaveLength(1);
    });

    const response = JSON.parse(ws.sentMessages[0]);
    expect(response).toMatchObject({
      id: "ping-1",
      success: true,
      result: {
        pong: true,
        version: VERSION,
      },
    });

    await server.close();
  });
});
