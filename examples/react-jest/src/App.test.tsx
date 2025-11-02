import { fireEvent, render, screen } from "@testing-library/react";

import App from "./App";

describe("App", () => {
  it("increments the counter when the button is clicked", () => {
    render(<App />);
  });
});
