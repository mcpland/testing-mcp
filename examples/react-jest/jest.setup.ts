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
    port: 3001,
    filePath: state.testPath,
    context: {
      userEvent,
      screen,
      fireEvent,
    },
  });
}, timeout);
