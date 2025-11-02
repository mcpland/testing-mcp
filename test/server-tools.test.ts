import { beforeEach, describe, expect, it, vi } from "vitest";

import { MCPTools } from "../src/server/tools.ts";
import type { ConnectionManager } from "../src/server/connectionManager.ts";
import type { FileEditor } from "../src/server/fileEditor.ts";
import type { TestState } from "../src/types/index.ts";

describe("MCPTools", () => {
  let tools: MCPTools;
  let connectionManager: {
    getCurrentState: ReturnType<typeof vi.fn>;
    getActiveConnections: ReturnType<typeof vi.fn>;
    sendClose: ReturnType<typeof vi.fn>;
    sendExecute: ReturnType<typeof vi.fn>;
  };
  let fileEditor: {
    removeConnect: ReturnType<typeof vi.fn>;
    removeMarkers: ReturnType<typeof vi.fn>;
    getGeneratedCode: ReturnType<typeof vi.fn>;
  };

  const baseState: TestState = {
    testFile: "/tests/sample.test.tsx",
    testName: "renders",
    dom: "<div />",
    snapshot: "<div />",
    consoleLogs: [],
    sessionId: "uuid-1",
  };

  beforeEach(() => {
    connectionManager = {
      getCurrentState: vi.fn(),
      getActiveConnections: vi.fn(),
      sendClose: vi.fn(),
      sendExecute: vi.fn(),
    };

    fileEditor = {
      removeConnect: vi.fn(),
      removeMarkers: vi.fn(),
      getGeneratedCode: vi.fn(),
    };

    tools = new MCPTools(
      connectionManager as unknown as ConnectionManager,
      fileEditor as unknown as FileEditor,
    );
  });

  it("returns the current test state when available", async () => {
    connectionManager.getCurrentState.mockReturnValue(baseState);

    const response = await tools.getCurrentTestState({});
    expect(response).toMatchObject({
      success: true,
      newState: baseState,
    });
  });

  it("fails to fetch current test state when none is active", async () => {
    connectionManager.getCurrentState.mockReturnValue(null);

    const response = await tools.getCurrentTestState({});
    expect(response.success).toBe(false);
    expect(response.error).toMatch(/No active test connection/);
  });

  it("finalizes tests by removing connect and markers, then closing connection", async () => {
    connectionManager.getActiveConnections.mockReturnValue([
      { testFile: baseState.testFile, testName: baseState.testName },
    ]);

    const result = await tools.finalizeTest({
      testFile: baseState.testFile,
      removeMarkers: true,
    });

    expect(fileEditor.removeConnect).toHaveBeenCalledWith(baseState.testFile);
    expect(fileEditor.removeMarkers).toHaveBeenCalledWith(baseState.testFile);
    expect(connectionManager.sendClose).toHaveBeenCalledWith(
      baseState.testFile,
      baseState.testName,
    );
    expect(result.success).toBe(true);
  });

  it("skips marker removal when disabled", async () => {
    connectionManager.getActiveConnections.mockReturnValue([]);

    await tools.finalizeTest({
      testFile: baseState.testFile,
      removeMarkers: false,
    });

    expect(fileEditor.removeConnect).toHaveBeenCalled();
    expect(fileEditor.removeMarkers).not.toHaveBeenCalled();
  });

  it("lists active tests with session metadata", async () => {
    connectionManager.getActiveConnections.mockReturnValue([
      {
        testFile: baseState.testFile,
        testName: baseState.testName,
        sessionId: "session-1",
        connectedAt: 1700000000000,
      },
    ]);

    const response = await tools.listActiveTests();
    expect(response.success).toBe(true);
    expect(response.newState).toMatchObject({
      tests: [
        expect.objectContaining({
          testFile: baseState.testFile,
          testName: baseState.testName,
          sessionId: "session-1",
        }),
      ],
    });
  });

  it("handles empty active test lists gracefully", async () => {
    connectionManager.getActiveConnections.mockReturnValue([]);
    const response = await tools.listActiveTests();
    expect(response.success).toBe(true);
    expect(response.message).toMatch(/No active test connections/);
  });

  it("retrieves generated code from file editor", async () => {
    fileEditor.getGeneratedCode.mockResolvedValue(["code block"]);

    const response = await tools.getGeneratedCode(baseState.testFile);
    expect(response).toMatchObject({
      success: true,
      code: "code block",
    });
  });

  it("executes test steps using the connection manager", async () => {
    connectionManager.getCurrentState.mockReturnValue(baseState);
    connectionManager.sendExecute.mockResolvedValue({
      ...baseState,
      dom: "<div>updated</div>",
    });

    const result = await tools.executeTestStep({
      code: "screen.getByText('Run');",
    });

    expect(connectionManager.sendExecute).toHaveBeenCalledWith(
      baseState.testFile,
      baseState.testName,
      "screen.getByText('Run');",
      30000,
    );
    expect(result.success).toBe(true);
    expect(result.newState?.dom).toContain("updated");
  });

  it("fails to execute test steps when no connection is active", async () => {
    connectionManager.getCurrentState.mockReturnValue(null);

    const result = await tools.executeTestStep({ code: "noop" });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/No active test connection/);
  });

  it("surfaces errors thrown by dependencies", async () => {
    fileEditor.removeConnect.mockRejectedValue(new Error("fs error"));
    connectionManager.getActiveConnections.mockReturnValue([]);

    const result = await tools.finalizeTest({
      testFile: baseState.testFile,
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("fs error");
  });
});
