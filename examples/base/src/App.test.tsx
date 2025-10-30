import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { connect } from "../../../src/client";
import { describe, it, expect } from "vitest";

import App from "./App";

describe("App", () => {
  it(
    "increments the counter when the button is clicked",
    async () => {
      render(<App />);
      await connect({ port: 3001, filePath: __filename });
    },
    1000 * 60 * 10
  );
});
