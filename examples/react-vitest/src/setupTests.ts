/* eslint-disable @typescript-eslint/no-require-imports */
import "@testing-library/jest-dom/vitest";
import { beforeEach, expect } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { connect } from "../../../src/client";

const timeout = 10 * 60 * 1000;

beforeEach((context) => {
  if (!process.env.TESTING_MCP) return;
  Object.assign(context.task, {
    timeout,
  });
});

/**
 * Connect to testing-mcp for interactive test development.
 *
 * IMPORTANT: Must be called AFTER render() and BEFORE the test ends.
 * Cannot be called in afterEach because @testing-library's cleanup()
 * runs first and clears the DOM.
 *
 * @example
 * ```typescript
 * it("test", async () => {
 *   render(<MyComponent />);
 *   await connectMCP();  // Call after render
 * });
 * ```
 */
export async function connectMCP() {
  if (!process.env.TESTING_MCP) return;

  const state = expect.getState();
  await connect({
    filePath: state.testPath,
    context: {
      userEvent,
      screen,
      expect,
      fireEvent,
    },
    contextDescriptions: {
      userEvent: "User event simulation library for typing, clicking, etc.",
      screen: "Testing library screen object for querying DOM elements",
      expect: "Vitest expect function for assertions",
      fireEvent: "Testing library fireEvent for triggering DOM events",
    },
  });
}
