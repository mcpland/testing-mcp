# Testing MCP

![Node CI](https://github.com/mcpland/testing-mcp/workflows/Node%20CI/badge.svg)
[![npm](https://img.shields.io/npm/v/testing-mcp.svg)](https://www.npmjs.com/package/testing-mcp)
![license](https://img.shields.io/npm/l/testing-mcp)

An MCP server for testing

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
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { connect } from "testing-mcp";

it(
  "logs the dashboard state",
  async () => {
    render(<Dashboard />);
    await connect({
      port: 3001,
      filePath: import.meta.url,
      context: { screen, fireEvent, userEvent },
    });
  },
  1000 * 60 * 10
);
```

Set `TESTING_MCP=true` locally to enable the bridge. The helper no-ops when the variable is missing or the tests run in continuous integration.

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

| Tool                     | Purpose                                                                   | Typical Usage                              |
| ------------------------ | ------------------------------------------------------------------------- | ------------------------------------------ |
| `get_current_test_state` | Fetch current DOM snapshot, console logs, and metadata for a running test | Inspect rendered output before acting      |
| `finalize_test`          | Remove `connect()` and generated markers, optionally close the session    | Commit the test file after guidance        |
| `list_active_tests`      | Enumerate active WebSocket sessions with timestamps                       | Review which tests are connected           |
| `get_generated_code`     | Extract helper-generated code blocks from a test file                     | Audit inserted scaffolding                 |
| `execute_test_step`      | Run code in the client context and return the updated state               | Trigger UI events without editing the test |

## License

MIT
