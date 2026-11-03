import type { ConnectContext, ConsoleLog, DiagnosticValue, ExecutionResult } from "../types/index.js";

const methods = ["log", "info", "warn", "error", "debug"] as const;
const MAX_LOGS = 100;
const MAX_LOG_BYTES = 64_000;

/** A bounded snapshot: no getters or user-defined toJSON methods are invoked. */
export function diagnosticValue(value: unknown): DiagnosticValue {
  const ancestors = new WeakSet<object>();
  let remaining = 200;
  function visit(item: unknown, depth: number): DiagnosticValue {
    if (--remaining < 0 || depth > 6) return "[Truncated]";
    if (item === null || typeof item === "boolean") return item;
    if (typeof item === "number") return Number.isFinite(item) ? item : String(item);
    if (typeof item === "string") return item.length > 4000 ? item.slice(0, 4000) + "[Truncated]" : item;
    if (typeof item === "bigint") return `${item}n`;
    if (typeof item === "undefined") return "[undefined]";
    if (typeof item === "symbol") return String(item);
    if (typeof item === "function") return `[Function ${item.name || "anonymous"}]`;
    if (ancestors.has(item)) return "[Circular]";
    ancestors.add(item);
    try {
      if (item instanceof Error) return { name: item.name, message: item.message };
      if (item instanceof Date) return Number.isNaN(item.getTime()) ? "Invalid Date" : item.toISOString();
      if (Array.isArray(item)) {
        const result = item.slice(0, 50).map(child => visit(child, depth + 1));
        if (item.length > 50) result.push("[Truncated]");
        return result;
      }
      if (item instanceof Map) return visit(Array.from(item.entries()).slice(0, 50), depth + 1);
      if (item instanceof Set) return visit(Array.from(item.values()).slice(0, 50), depth + 1);
      const entries = Object.entries(Object.getOwnPropertyDescriptors(item)).filter(([, descriptor]) => descriptor.enumerable);
      const result = Object.fromEntries(entries.slice(0, 50).map(([key, descriptor]) => [
        key, "value" in descriptor ? visit(descriptor.value, depth + 1) : "[Accessor]",
      ]));
      if (entries.length > 50) result["[Truncated]"] = true;
      return result;
    } catch {
      return "[Unserializable]";
    } finally {
      ancestors.delete(item);
    }
  }
  return visit(value, 0);
}

export function executionError(error: unknown): NonNullable<ExecutionResult["error"]> {
  if (error instanceof Error) return { name: error.name, message: error.message, stack: error.stack };
  return { name: "Error", message: typeof error === "string" ? error : JSON.stringify(diagnosticValue(error)) };
}

// A process can host multiple test connections. Keep their console capture and
// DOM mutations separate, including after a failed step.
let executionQueue: Promise<unknown> = Promise.resolve();
export function enqueueExecution<T>(run: () => Promise<T>): Promise<T> {
  const result = executionQueue.then(run);
  executionQueue = result.catch(() => {});
  return result;
}

export async function executeWithDiagnostics(
  executeId: string,
  code: string,
  context: ConnectContext,
): Promise<{ execution: ExecutionResult; consoleLogs: ConsoleLog[] }> {
  const consoleLogs: ConsoleLog[] = [];
  let logBytes = 0;
  let truncated = false;
  const record = (type: ConsoleLog["type"], args: unknown[]) => {
    const snapshot = diagnosticValue(args) as DiagnosticValue[];
    const bytes = JSON.stringify(snapshot).length;
    if (consoleLogs.length >= MAX_LOGS || logBytes + bytes > MAX_LOG_BYTES) {
      if (!truncated) consoleLogs.push({ type: "warn", args: ["[Console output truncated]"], timestamp: Date.now() });
      truncated = true;
      return;
    }
    consoleLogs.push({ type, args: snapshot, timestamp: Date.now() });
    logBytes += bytes;
  };

  const targets: object[] = [console];
  if (typeof window !== "undefined" && window.console && !targets.includes(window.console)) targets.push(window.console);
  const injectedConsole = context.console as unknown;
  const source = typeof injectedConsole === "object" && injectedConsole !== null ? injectedConsole : console;
  const originals = new Map<ConsoleLog["type"], unknown>();
  for (const method of methods) originals.set(method, Reflect.get(source, method));
  const restore: (() => void)[] = [];
  let forwarding = 0;
  const forward = (type: ConsoleLog["type"], target: object, original: unknown, args: unknown[]) => {
    if (forwarding === 0) record(type, args);
    forwarding++;
    try { if (typeof original === "function") Reflect.apply(original, target, args); }
    finally { forwarding--; }
  };
  try {
    for (const target of targets) {
      for (const method of methods) {
        const original = Reflect.get(target, method) as unknown;
        if (typeof original !== "function") continue;
        const descriptor = Object.getOwnPropertyDescriptor(target, method);
        try {
          Object.defineProperty(target, method, {
            configurable: true, writable: true,
            value: (...args: unknown[]) => forward(method, target, original, args),
          });
          restore.push(() => {
            if (descriptor) Object.defineProperty(target, method, descriptor);
            else Reflect.deleteProperty(target, method);
          });
        } catch {
          // Frozen consoles still work through the injected execution facade.
        }
      }
    }
    const facade = new Proxy({}, {
      get(_target, key) {
        if (methods.includes(key as ConsoleLog["type"])) {
          const method = key as ConsoleLog["type"];
          const original = originals.get(method);
          return (...args: unknown[]) => {
            forward(method, source, original, args);
          };
        }
        const value = Reflect.get(source, key) as unknown;
        return typeof value === "function" ? value.bind(source) : value;
      },
    });
    const injected = { ...context, console: facade };
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as
      new (...args: string[]) => (...values: unknown[]) => Promise<unknown>;
    const executor = new AsyncFunction(...Object.keys(injected), code);
    const value = await executor(...Object.values(injected));
    const execution: ExecutionResult = { executeId, success: true };
    if (value !== undefined) execution.result = diagnosticValue(value);
    return { execution, consoleLogs };
  } catch (error) {
    return { execution: { executeId, success: false, error: executionError(error) }, consoleLogs };
  } finally {
    for (const reset of restore.reverse()) reset();
  }
}
