import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { diagnosticValue, enqueueExecution, executeWithDiagnostics } from "../src/client/execution.js";

describe("execution diagnostics", () => {
  beforeEach(() => {
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation(() => {});
    }
  });
  afterEach(() => vi.restoreAllMocks());

  it("returns a structured value and captures both direct and application console calls", async () => {
    const original = console.warn;
    const result = await executeWithDiagnostics("step-1", `
      console.log('inspection', { count: 2 });
      notify();
      return { answer: 42 };
    `, { notify: () => console.warn("application warning") });
    expect(result.execution).toEqual({ executeId: "step-1", success: true, result: { answer: 42 } });
    expect(result.consoleLogs.map(log => [log.type, log.args])).toEqual([
      ["log", ["inspection", { count: 2 }]], ["warn", ["application warning"]],
    ]);
    expect(console.warn).toBe(original);
    expect(original).toHaveBeenCalledTimes(1);
  });

  it("captures a frozen injected console without double-counting forwarding", async () => {
    const log = vi.fn((...args: unknown[]) => console.log(...args));
    const injected = Object.freeze({ log });
    const result = await executeWithDiagnostics("injected", "console.log('hello');", { console: injected });
    expect(result.execution.success).toBe(true);
    expect(result.consoleLogs.map(item => item.args)).toEqual([["hello"]]);
    expect(log).toHaveBeenCalledOnce();
    expect(injected.log).toBe(log);
  });

  it("reports assertion failures with their logs, restores console, and starts the next step cleanly", async () => {
    const original = console.error;
    const failed = await executeWithDiagnostics("failed", "console.error('before failure'); throw new TypeError('wrong value');", {});
    expect(failed.execution).toMatchObject({ executeId: "failed", success: false, error: { name: "TypeError", message: "wrong value" } });
    expect(failed.consoleLogs[0].args).toEqual(["before failure"]);
    expect(console.error).toBe(original);
    const next = await executeWithDiagnostics("next", "return 7;", {});
    expect(next).toEqual({ execution: { executeId: "next", success: true, result: 7 }, consoleLogs: [] });
  });

  it("snapshots cycles and non-JSON values without invoking getters or toJSON", async () => {
    const getter = vi.fn(() => { throw new Error("must not run"); });
    const toJSON = vi.fn(() => { throw new Error("must not run"); });
    const value: Record<string, unknown> = { count: 3n, failure: new Error("example"), toJSON };
    value.self = value;
    Object.defineProperty(value, "hiddenWork", { enumerable: true, get: getter });
    const result = await executeWithDiagnostics("values", "console.log(value); return value;", { value });
    expect(result.execution.success).toBe(true);
    expect(result.execution.result).toMatchObject({ count: "3n", self: "[Circular]", failure: { name: "Error", message: "example" }, hiddenWork: "[Accessor]" });
    expect(() => JSON.stringify(result)).not.toThrow();
    expect(getter).not.toHaveBeenCalled();
    expect(toJSON).not.toHaveBeenCalled();
  });

  it("bounds console output and marks truncation", async () => {
    const result = await executeWithDiagnostics("many-logs", "for (let i = 0; i < 150; i++) console.debug(i);", {});
    expect(result.execution.success).toBe(true);
    expect(result.consoleLogs).toHaveLength(101);
    expect(result.consoleLogs[100].args).toEqual(["[Console output truncated]"]);
    expect(diagnosticValue("a".repeat(5000))).toContain("[Truncated]");
  });

  it("serializes overlapping steps so their logs do not leak into each other", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const first = enqueueExecution(() => executeWithDiagnostics("first", "await gate; console.log('first'); return 1;", { gate }));
    const second = enqueueExecution(() => executeWithDiagnostics("second", "console.log('second'); return 2;", {}));
    release();
    const [one, two] = await Promise.all([first, second]);
    expect(one.consoleLogs.map(log => log.args)).toEqual([["first"]]);
    expect(two.consoleLogs.map(log => log.args)).toEqual([["second"]]);
  });
});
