import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BridgeClient } from "../src/adapter/bridgeClient.js";
import { FileEditor } from "../src/adapter/fileEditor.js";
import { MCPTools } from "../src/adapter/tools.js";
import type { TestState } from "../src/types/index.js";

const state: TestState = {
  testFile: "/tests/pane.test.tsx", testName: "pane", dom: "<main />", snapshot: "<main />", consoleLogs: [],
};

describe("execute_test_step result classification", () => {
  let bridge: BridgeClient;
  let tools: MCPTools;
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    bridge = new BridgeClient({ autoStartDaemon: false });
    vi.spyOn(bridge, "getCurrentState").mockResolvedValue(state);
    vi.spyOn(bridge, "sendExecute").mockResolvedValue(state);
    tools = new MCPTools(bridge, new FileEditor());
  });
  afterEach(() => vi.restoreAllMocks());

  it("exposes the actual return value on successful execution", async () => {
    const next: TestState = { ...state, execution: { executeId: "one", success: true, result: { count: 2 } } };
    vi.mocked(bridge.sendExecute).mockResolvedValue(next);
    await expect(tools.executeTestStep({ code: "return { count: 2 };" })).resolves.toMatchObject({
      success: true, result: { count: 2 }, newState: next,
    });
  });

  it("does not report RPC delivery as successful code execution", async () => {
    const next: TestState = {
      ...state, errors: ["expected 2, received 1"],
      execution: { executeId: "failed", success: false, error: { name: "AssertionError", message: "expected 2, received 1" } },
    };
    vi.mocked(bridge.sendExecute).mockResolvedValue(next);
    await expect(tools.executeTestStep({ code: "expect(1).toBe(2);" })).resolves.toMatchObject({
      success: false, error: "expected 2, received 1", newState: next,
    });
  });

  it("keeps errors from older clients meaningful without execution metadata", async () => {
    vi.mocked(bridge.sendExecute).mockResolvedValue({ ...state, errors: ["legacy assertion"] });
    await expect(tools.executeTestStep({ code: "legacy();" })).resolves.toMatchObject({ success: false, error: "legacy assertion" });
  });

  it("preserves transport failures as failures", async () => {
    vi.mocked(bridge.sendExecute).mockRejectedValue(new Error("Connection closed"));
    await expect(tools.executeTestStep({ code: "return 1;" })).resolves.toMatchObject({ success: false, error: "Connection closed" });
  });
});
