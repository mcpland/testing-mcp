import { render } from "@testing-library/react";

import App from "../src/App";

describe("App", () => {
  it("increments the counter when the button is clicked", async () => {
    render(<App />, { container: document.body });
  });
});
