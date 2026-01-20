import "@testing-library/jest-dom";
import { screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { connect } from "../../src/client";

const timeout = 10 * 60 * 1000;

if (process.env.TESTING_MCP) {
  jest.setTimeout(timeout);
}

afterEach(async () => {
  if (!process.env.TESTING_MCP) return;
  const state = expect.getState();
  await connect({
    // No fixed port - use auto-discovery from daemon registry
    // The connect function will wait for daemon to be ready
    filePath: state.testPath,
    context: {
      userEvent,
      screen,
      fireEvent,
    },
    contextDescriptions: {
      userEvent: "User event simulation library for typing, clicking, etc.",
      screen: "Testing library screen object for querying DOM elements",
      fireEvent: "Testing library fireEvent for triggering DOM events",
    },
  });
}, timeout);
