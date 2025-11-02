import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const originalEnv = { ...process.env };
const originalRequire = (global as any).require;

class MockWebSocket {
  static instances: MockWebSocket[] = [];

  public url: string;
  public sentMessages: string[] = [];

  private listeners = new Map<string, Array<(data?: any) => void>>();

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  static reset() {
    this.instances.length = 0;
  }

  on(event: string, handler: (data?: any) => void) {
    const list = this.listeners.get(event) ?? [];
    list.push(handler);
    this.listeners.set(event, list);
  }

  addEventListener(event: string, handler: (data?: any) => void) {
    this.on(event, handler);
  }

  send(payload: string) {
    this.sentMessages.push(payload);
  }

  close() {
    this.emit("close");
  }

  emit(event: string, data?: any) {
    const list = this.listeners.get(event) ?? [];
    for (const handler of list) {
      handler(data);
    }
  }

  emitMessage(message: unknown) {
    const payload = Buffer.from(JSON.stringify(message));
    this.emit("message", payload);
  }
}

describe("client/connect", () => {
  beforeEach(() => {
    vi.resetModules();
    MockWebSocket.reset();
    process.env = { ...originalEnv };
    (globalThis as any).TESTING_MCP_SESSION_ID = undefined;
    vi.stubGlobal("console", {
      ...console,
      error: vi.fn(),
    });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.doUnmock("ws");
    (global as any).require = originalRequire;
  });

  it("skips connection when TESTING_MCP is not enabled", async () => {
    const { connect } = await import("../src/client/connect.ts");

    await expect(connect({ port: 1234 })).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledWith(
      "[testing-mcp] Skipping in CI/non-dev environment",
    );
  });

  it("connects to server, handles execution, and cleans up session", async () => {
    process.env.TESTING_MCP = "1";
    delete process.env.CI;
    (global as any).require = vi
      .fn()
      .mockImplementation(() => ({ prettyDOM: () => "<pretty-dom />" }));

    const mockDocument = {
      body: {
        innerHTML: "<div id='root'></div>",
        outerHTML: "<html><body><div id='root'></div></body></html>",
      },
    };

    vi.stubGlobal("document", mockDocument);
    vi.stubGlobal("window", {});
    vi.stubGlobal("WebSocket", MockWebSocket);

    const { connect } = await import("../src/client/connect.ts");

    const connectPromise = connect({
      port: 4321,
      filePath: "/tests/demo.test.tsx",
      context: {
        document: mockDocument,
        window: {},
        console,
        screen: { debug: vi.fn() },
        fireEvent: vi.fn(),
      },
    });

    await vi.waitFor(() => {
      expect(MockWebSocket.instances.length).toBeGreaterThan(0);
    });
    const ws = MockWebSocket.instances[0];

    // Simulate WebSocket open to trigger READY payload
    ws.emit("open");

    expect(ws.sentMessages).not.toHaveLength(0);
    const readyPayload = JSON.parse(ws.sentMessages[0]);
    expect(readyPayload.type).toBe("ready");
    expect(readyPayload.data.dom).toBe("<div id='root'></div>");
    expect(readyPayload.data.snapshot).toContain("<html");
    expect(readyPayload.data.testFile).toBe("/tests/demo.test.tsx");

    // Connected message assigns session id
    ws.emitMessage({
      type: "connected",
      data: { sessionId: "session-123" },
    });
    expect(process.env.TESTING_MCP_SESSION_ID).toBe("session-123");

    // Continue message keeps connection alive
    ws.emitMessage({ type: "continue" });

    // Execute message should run code and respond with updated DOM
    ws.emitMessage({
      type: "execute",
      data: {
        executeId: "exec-1",
        code: `
          console.error("executing");
          document.body.innerHTML = "<span>updated</span>";
        `,
      },
    });

    await vi.waitFor(() => {
      expect(
        ws.sentMessages.some((payload) => {
          const parsed = JSON.parse(payload);
          return (
            parsed.type === "executed" &&
            parsed.data.state.dom.includes("<span>updated</span>")
          );
        }),
      ).toBe(true);
    });

    // Closing message should resolve connect()
    ws.emitMessage({ type: "close" });
    ws.close();

    await expect(connectPromise).resolves.toBeUndefined();
    expect(process.env.TESTING_MCP_SESSION_ID).toBeUndefined();
  });

  it("reports execution errors and keeps DOM snapshot available", async () => {
    process.env.TESTING_MCP = "1";
    (global as any).require = vi.fn().mockImplementation(() => {
      throw new Error("not installed");
    });

    const mockDocument = {
      body: {
        innerHTML: "<main></main>",
        outerHTML: "<html><body><main></main></body></html>",
      },
    };

    vi.stubGlobal("document", mockDocument);
    vi.stubGlobal("window", {});
    vi.stubGlobal("WebSocket", MockWebSocket);

    const { connect } = await import("../src/client/connect.ts");

    const connectPromise = connect({
      port: 5555,
      waitForAsync: false,
      filePath: "/tests/error.test.tsx",
      context: { console, document: mockDocument, window: {} },
    });

    await vi.waitFor(() => {
      expect(MockWebSocket.instances.length).toBeGreaterThan(0);
    });
    const ws = MockWebSocket.instances[0];
    ws.emit("open");

    // Trigger an execution failure
    ws.emitMessage({
      type: "execute",
      data: {
        executeId: "exec-error",
        code: `throw new Error("boom");`,
      },
    });

    await vi.waitFor(() => {
      expect(
        ws.sentMessages.some((payload) => {
          const parsed = JSON.parse(payload);
          return (
            parsed.type === "executed" &&
            parsed.data.state.errors?.includes("boom")
          );
        }),
      ).toBe(true);
    });

    ws.emitMessage({ type: "close" });
    ws.close();
    await connectPromise;
  });

  it("falls back to ws module when global WebSocket is unavailable", async () => {
    process.env.TESTING_MCP = "1";
    delete (globalThis as any).WebSocket;

    class NodeStyleWebSocket extends MockWebSocket {}

    vi.doMock("ws", () => ({ default: NodeStyleWebSocket }), {
      virtual: true,
    });

    const mockDocument = {
      body: {
        innerHTML: "<body></body>",
        outerHTML: "<body></body>",
      },
    };

    vi.stubGlobal("document", mockDocument);
    vi.stubGlobal("window", {});

    const { connect } = await import("../src/client/connect.ts");

    const promise = connect({
      port: 6000,
      waitForAsync: false,
      filePath: "/tests/ws.test.tsx",
      context: { console, document: mockDocument, window: {} },
    });

    await vi.waitFor(() => {
      expect(MockWebSocket.instances.length).toBeGreaterThan(0);
    });
    const ws = MockWebSocket.instances[0];

    ws.emit("open");
    ws.emitMessage({ type: "close" });
    ws.close();
    await promise;
  });
});
