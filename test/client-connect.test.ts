import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";

const originalEnv = { ...process.env };
const originalRequire = (global as any).require;

// Mock registry data
const mockRegistry = {
  pid: process.pid, // Use current process PID so isProcessRunning returns true
  wsPort: 4321,
  rpcPort: 4322,
  token: "test-token",
  startedAt: new Date().toISOString(),
  version: "0.4.0",
  protocol: 1,
};

class MockWebSocket {
  static instances: MockWebSocket[] = [];

  public url: string;
  public sentMessages: string[] = [];

  private listeners = new Map<string, Array<(...args: any[]) => void>>();

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  static reset() {
    this.instances.length = 0;
  }

  on(event: string, handler: (...args: any[]) => void) {
    const list = this.listeners.get(event) ?? [];
    list.push(handler);
    this.listeners.set(event, list);
  }

  addEventListener(event: string, handler: (...args: any[]) => void) {
    this.on(event, handler);
  }

  send(payload: string) {
    this.sentMessages.push(payload);
  }

  close(code?: number, reason?: unknown) {
    this.emit("close", code, reason);
  }

  emit(event: string, ...args: any[]) {
    const list = this.listeners.get(event) ?? [];
    for (const handler of list) {
      handler(...args);
    }
  }

  emitMessage(message: unknown) {
    const payload = Buffer.from(JSON.stringify(message));
    this.emit("message", payload);
  }
}

describe("client/connect", () => {
  let registryDir: string;
  let registryPath: string;

  beforeEach(async () => {
    vi.resetModules();
    MockWebSocket.reset();
    process.env = { ...originalEnv };
    (globalThis as any).TESTING_MCP_SESSION_ID = undefined;
    vi.stubGlobal("console", {
      ...console,
      error: vi.fn(),
      log: vi.fn(),
      warn: vi.fn(),
    });

    // Setup mock registry file in an isolated data directory
    registryDir = await fs.mkdtemp(path.join(os.tmpdir(), "testing-mcp-client-"));
    process.env.TESTING_MCP_DATA_DIR = registryDir;
    registryPath = path.join(registryDir, "bridge.json");
    await fs.mkdir(registryDir, { recursive: true });
    await fs.writeFile(registryPath, JSON.stringify(mockRegistry));
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.doUnmock("ws");
    (global as any).require = originalRequire;

    try {
      await fs.rm(registryDir, { force: true, recursive: true });
    } catch {
      // Ignore if cleanup races with a test failure
    }
  });

  it("skips connection when TESTING_MCP is not enabled", async () => {
    const { connect } = await import("../src/client/connect.ts");

    await expect(connect({})).resolves.toBeUndefined();
    expect(console.log).toHaveBeenCalledWith(
      "[testing-mcp] Skipping in CI/non-dev environment"
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
        })
      ).toBe(true);
    });

    // Closing message should resolve connect()
    ws.emitMessage({ type: "close" });
    ws.close();

    await expect(connectPromise).resolves.toBeUndefined();
    expect(process.env.TESTING_MCP_SESSION_ID).toBeUndefined();
  });

  it("uses an explicit port and token before registry auto-discovery", async () => {
    process.env.TESTING_MCP = "1";
    delete process.env.CI;

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
      filePath: "/tests/explicit-port.test.tsx",
      port: 9876,
      token: "explicit-token",
      waitForAsync: false,
      context: { console, document: mockDocument, window: {} },
    });

    await vi.waitFor(() => {
      expect(MockWebSocket.instances.length).toBe(1);
    });

    const ws = MockWebSocket.instances[0];
    expect(ws.url).toBe("ws://localhost:9876?token=explicit-token");
    ws.emit("open");
    ws.emitMessage({ type: "close" });
    ws.close();

    await connectPromise;
  });

  it("uses TESTING_MCP_PORT before registry auto-discovery", async () => {
    process.env.TESTING_MCP = "1";
    process.env.TESTING_MCP_PORT = "7654";
    process.env.TESTING_MCP_TOKEN = "env-token";
    delete process.env.CI;

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
      filePath: "/tests/env-port.test.tsx",
      waitForAsync: false,
      context: { console, document: mockDocument, window: {} },
    });

    await vi.waitFor(() => {
      expect(MockWebSocket.instances.length).toBe(1);
    });

    const ws = MockWebSocket.instances[0];
    expect(ws.url).toBe("ws://localhost:7654?token=env-token");
    ws.emit("open");
    ws.emitMessage({ type: "close" });
    ws.close();

    await connectPromise;
  });

  it("re-resolves the registry after a connection failure", async () => {
    process.env.TESTING_MCP = "1";
    delete process.env.CI;

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
      filePath: "/tests/reresolve.test.tsx",
      waitForAsync: false,
      context: { console, document: mockDocument, window: {} },
    });

    await vi.waitFor(() => {
      expect(MockWebSocket.instances.length).toBe(1);
    });

    const first = MockWebSocket.instances[0];
    expect(first.url).toBe("ws://localhost:4321?token=test-token");

    await fs.writeFile(
      registryPath,
      JSON.stringify({
        ...mockRegistry,
        wsPort: 9876,
      })
    );
    first.emit("error", { type: "error" });

    await vi.waitFor(
      () => {
        expect(MockWebSocket.instances.length).toBe(2);
      },
      { timeout: 3000 }
    );

    const second = MockWebSocket.instances[1];
    expect(second.url).toBe("ws://localhost:9876?token=test-token");
    second.emit("open");
    second.emitMessage({ type: "close" });
    second.close();

    await connectPromise;
  });

  it("waits for daemon registry only once before retrying fallback port", async () => {
    process.env.TESTING_MCP = "1";
    delete process.env.CI;
    delete process.env.TESTING_MCP_PORT;
    delete process.env.TESTING_MCP_TOKEN;
    await fs.rm(registryPath, { force: true });

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
      filePath: "/tests/fallback-retry.test.tsx",
      waitForAsync: false,
      daemonWaitTimeout: 5,
      context: { console, document: mockDocument, window: {} },
    });

    await vi.waitFor(() => {
      expect(MockWebSocket.instances.length).toBe(1);
    });

    const first = MockWebSocket.instances[0];
    expect(first.url).toBe("ws://localhost:3001");
    first.emit("error", { type: "error" });
    first.close();

    await vi.waitFor(
      () => {
        expect(MockWebSocket.instances.length).toBe(2);
      },
      { timeout: 3000 }
    );

    const second = MockWebSocket.instances[1];
    expect(second.url).toBe("ws://localhost:3001");
    second.emit("open");
    second.emitMessage({ type: "close" });
    second.close();

    await connectPromise;

    const waitLogs = vi.mocked(console.log).mock.calls.filter(([message]) =>
      String(message).includes("Waiting for daemon to be ready")
    );
    expect(waitLogs).toHaveLength(1);
  });

  it("does not retry invalid daemon token closes", async () => {
    process.env.TESTING_MCP = "1";
    delete process.env.CI;

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
      filePath: "/tests/invalid-token.test.tsx",
      port: 9876,
      token: "wrong-token",
      waitForAsync: false,
      context: { console, document: mockDocument, window: {} },
    });

    await vi.waitFor(() => {
      expect(MockWebSocket.instances.length).toBe(1);
    });

    const ws = MockWebSocket.instances[0];
    expect(ws.url).toBe("ws://localhost:9876?token=wrong-token");
    ws.emit("open");
    ws.close(1008, Buffer.from("Invalid token"));

    await expect(connectPromise).rejects.toThrow("Invalid daemon token");
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it("reports execution errors and keeps DOM snapshot available", async () => {
    process.env.TESTING_MCP = "1";
    delete process.env.CI;
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
        })
      ).toBe(true);
    });

    ws.emitMessage({ type: "close" });
    ws.close();
    await connectPromise;
  });

  it("falls back to ws module when global WebSocket is unavailable", async () => {
    process.env.TESTING_MCP = "1";
    delete process.env.CI;
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
