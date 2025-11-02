/* eslint-disable @typescript-eslint/no-require-imports */
import "@testing-library/jest-dom/vitest";
import { beforeEach, afterEach, expect } from "vitest";
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

afterEach(async () => {
  if (!process.env.TESTING_MCP) return;
  const state = expect.getState();
  await connect({
    port: 3001,
    filePath: state.testPath,
    context: {
      userEvent,
      screen,
      expect,
      fireEvent,
    },
  });
}, timeout);
