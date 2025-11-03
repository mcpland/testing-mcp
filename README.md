# Testing MCP

![Node CI](https://github.com/mcpland/testing-mcp/workflows/Node%20CI/badge.svg)
[![npm](https://img.shields.io/npm/v/testing-mcp.svg)](https://www.npmjs.com/package/testing-mcp)
![license](https://img.shields.io/npm/l/testing-mcp)

An MCP server that bridges Claude with your running tests, enabling real-time test state inspection and interactive debugging.

## Motivation

Writing and debugging tests traditionally involves a frustrating cycle:

1. **Write test code** → Run tests → Read error messages → Guess what went wrong → Repeat
2. **Debug failures** by adding `console.log` statements or using breakpoints
3. **Collaborate with AI** that can't see your test environment's actual state
4. **Manually describe** DOM state and available APIs to AI assistants

**Testing MCP solves these problems** by creating a live bridge between Claude and your test environment:

- **Claude can see** the actual DOM state, console logs, and rendered output
- **Claude can execute** code directly in your test without editing files
- **Claude knows** exactly which testing APIs are available (screen, fireEvent, etc.)
- **You iterate faster** with real-time feedback instead of blind guessing

## Features

### 🔍 **Real-Time Test Inspection**

View live DOM snapshots, console logs, and test metadata through MCP tools. No more adding temporary `console.log` statements or running tests repeatedly to see what's happening.

### 🎯 **Remote Code Execution**

Execute JavaScript/TypeScript directly in your running test environment. Test interactions, check DOM state, or run assertions without modifying your test files.

### 🧠 **Smart Context Awareness**

Automatically collects and exposes available testing APIs (like `screen`, `fireEvent`, `waitFor`) with type information and descriptions. Claude knows exactly what's available and generates valid code on the first try.

```ts
await connect({
  context: { screen, fireEvent, waitFor },
  contextDescriptions: {
    screen: "React Testing Library screen with query methods",
    fireEvent: "Function to trigger DOM events",
  },
});
```

### 🔄 **Session Management**

Reliable WebSocket connections with session tracking, reconnection support, and automatic cleanup. Multiple tests can connect simultaneously.

### 🚫 **Zero CI Overhead**

Automatically disabled in CI environments. The `connect()` call becomes a no-op when `TESTING_MCP` is not set, so your tests run normally in production.

### 🤖 **AI-First Design**

Built specifically for Claude and MCP protocol. Provides structured metadata, clear tool descriptions, and predictable responses optimized for AI understanding.

## Get Started

### Installation

Install dependencies and build the project before launching the MCP server or consuming the client helper.

```bash
npm install -D testing-mcp
# or
yarn add -D testing-mcp
# or
pnpm add -D testing-mcp
```

**Node 18+** is required because the project uses ES modules and the WebSocket API.

### Setup the MCP Server

Use the provided script to start the MCP server over stdio.

```json
{
  "testing-mcp": {
    "command": "npx",
    "args": ["-y", "testing-mcp@latest"]
  }
}
```

The server opens a WebSocket bridge on port `3001` (configurable) and registers MCP tools for state inspection, file editing, and remote code execution.

## Connect From Tests

Import the client helper in your Vitest or Jest suites to expose the DOM state to the MCP server.

```ts
// example.test.tsx
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { connect } from "testing-mcp";

it(
  "logs the dashboard state",
  async () => {
    render(<Dashboard />);
    await connect({
      port: 3001,
      filePath: import.meta.url,
      context: {
        screen,
        fireEvent,
        userEvent,
        waitFor,
      },
      // Optional: provide descriptions to help Claude understand the APIs
      contextDescriptions: {
        screen: "React Testing Library screen with query methods",
        fireEvent: "Synchronous event triggering function",
        userEvent: "User interaction simulation library",
        waitFor: "Async utility for waiting on conditions",
      },
    });
  },
  1000 * 60 * 10
);
```

Set `TESTING_MCP=true` locally to enable the bridge. The helper no-ops when the variable is missing or the tests run in continuous integration.

## Context and Available APIs

The `connect()` function accepts a `context` object that injects APIs and variables into the test execution environment. This allows Claude to know exactly what APIs are available when generating code with `execute_test_step`.

### Basic Usage

```ts
await connect({
  context: {
    screen, // React Testing Library screen object
    fireEvent, // DOM event trigger function
    userEvent, // User interaction simulation
    waitFor, // Async waiting utility
  },
});
```

### Enhanced with Descriptions

You can optionally provide descriptions for each context key to help Claude understand what APIs are available and how to use them:

```ts
await connect({
  context: {
    screen,
    fireEvent,
    waitFor,
    customHelper: async (text: string) => {
      const button = screen.getByText(text);
      fireEvent.click(button);
      await waitFor(() => {});
    },
  },
  contextDescriptions: {
    screen:
      "React Testing Library screen object with query methods (getByText, findByRole, etc.)",
    fireEvent: "Function to trigger DOM events like click, change, etc.",
    waitFor:
      "Async utility to wait for assertions - waitFor(() => expect(...).toBe(...))",
    customHelper:
      "Custom helper: async (text: string) => void - Clicks a button by its text and waits",
  },
});
```

### How It Works

1. **Automatic Collection**: The client automatically collects metadata about each context key, including:

   - Key name
   - Type (function, object, string, etc.)
   - Function signature (for functions)

2. **Optional Descriptions**: You can provide human-readable descriptions via `contextDescriptions` to give Claude more context about each API.

3. **Available in State**: When Claude calls `get_current_test_state`, the response includes an `availableContext` field listing all available APIs with their metadata.

4. **Smart Code Generation**: Claude uses this information to generate valid `execute_test_step` code that only references available APIs.

### Example Response

```json
{
  "success": true,
  "newState": {
    "availableContext": [
      {
        "name": "screen",
        "type": "object",
        "description": "React Testing Library screen object with query methods"
      },
      {
        "name": "fireEvent",
        "type": "function",
        "signature": "(element, event) => ...",
        "description": "Function to trigger DOM events"
      },
      {
        "name": "customHelper",
        "type": "function",
        "signature": "(text) => ...",
        "description": "Custom helper for clicking buttons"
      }
    ]
  }
}
```

### Environment Variables

- `TESTING_MCP`: When set to `true`, the client helper attempts to open a WebSocket bridge to the MCP server. Leave it unset (the default) to disable the bridge—this is automatically the case in CI.
- `TESTING_MCP_PORT`: Overrides the WebSocket port the MCP server listens on. Defaults to `3001`; set this if the default port is already occupied or you want multiple servers running side by side.

**Custom port example**

```json
{
  "testing-mcp": {
    "command": "npx",
    "args": ["-y", "testing-mcp@latest"],
    "env": {
      "TESTING_MCP_PORT": "4001"
    }
  }
}
```

## Architecture Overview

**The MCP server listens to test events over WebSockets and responds with tooling actions.**

- Client-side tests call `connect()` to push DOM snapshots, console logs, and metadata when they reach important checkpoints.
- The server captures each session, exposes it through MCP tools, and can inject additional code or finalize modified files.
- Communication stays resilient to reconnections by tracking a per-session UUID and cleaning callbacks on close.

## MCP Tools

| Tool                     | Purpose                                                                                               | Typical Usage                                               |
| ------------------------ | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `get_current_test_state` | Fetch current DOM snapshot, console logs, metadata, and **available context APIs** for a running test | Inspect rendered output and available APIs                  |
| `finalize_test`          | Remove `connect()` and generated markers, optionally close the session                                | Commit the test file after guidance                         |
| `list_active_tests`      | Enumerate active WebSocket sessions with timestamps                                                   | Review which tests are connected                            |
| `get_generated_code`     | Extract helper-generated code blocks from a test file                                                 | Audit inserted scaffolding                                  |
| `execute_test_step`      | Run code in the client context using available APIs and return the updated state                      | Trigger UI events using context-provided APIs or other APIs |

### Tool Details

#### `get_current_test_state`

Returns the current test state including:

- **DOM snapshot**: Current rendered HTML
- **Console logs**: Captured console output
- **Test metadata**: Test file path, test name, session ID
- **Available context**: List of all APIs/variables available in `execute_test_step`, including their types, signatures, and descriptions

**Response includes `availableContext` field**:

```json
{
  "availableContext": [
    {
      "name": "screen",
      "type": "object",
      "description": "React Testing Library screen object"
    },
    {
      "name": "fireEvent",
      "type": "function",
      "signature": "(element, event) => ...",
      "description": "Function to trigger DOM events"
    }
  ]
}
```

#### `execute_test_step`

Executes JavaScript/TypeScript code in the connected test client. The code can use any APIs listed in the `availableContext` field from `get_current_test_state`.

**Best Practice**: Always call `get_current_test_state` first to check which APIs are available before using `execute_test_step`.

## License

MIT
