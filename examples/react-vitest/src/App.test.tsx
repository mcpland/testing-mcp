import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect } from "vitest";

import App from "./App";

describe("App", () => {
  it("increments the counter when the button is clicked", async () => {
    render(<App />);
    const button = screen.getByRole("button", { name: /count is 0/i });
    await userEvent.click(button);
    expect(
      screen.getByRole("button", { name: /count is 1/i })
    ).toBeInTheDocument();
  });
});
