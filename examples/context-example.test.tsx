import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { connect } from "testing-mcp/client";
import App from "./src/App";

describe("App with Context Example", () => {
  it("demonstrates context and contextDescriptions usage", async () => {
    // Render the component
    render(<App />, { container: document.body });

    // Custom helper function
    const clickButton = async (text: string) => {
      const button = screen.getByText(text);
      fireEvent.click(button);
      await waitFor(() => {});
    };

    // Connect with context and descriptions
    await connect({
      context: {
        screen,
        fireEvent,
        waitFor,
        clickButton,
      },
      contextDescriptions: {
        screen: "React Testing Library screen object with query methods (getByText, findByRole, etc.)",
        fireEvent: "Function to trigger DOM events like click, change, etc.",
        waitFor: "Async utility to wait for assertions - waitFor(() => expect(...).toBe(...))",
        clickButton: "Custom helper: async (text: string) => void - Clicks a button by its text and waits",
      },
    });
  });
});
