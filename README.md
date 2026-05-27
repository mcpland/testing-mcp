# Testing MCP

![Node CI](https://github.com/mcpland/testing-mcp/workflows/Node%20CI/badge.svg)
[![npm](https://img.shields.io/npm/v/testing-mcp.svg)](https://www.npmjs.com/package/testing-mcp)
![license](https://img.shields.io/npm/l/testing-mcp)

Write complex integration tests with AI - AI assistants see your live page structure, execute code, and iterate until tests work

## Table of Contents

- [Quick Start](#quick-start)
- [Why Testing MCP](#why-testing-mcp)
- [What Testing MCP Does](#what-testing-mcp-does)
- [Installation](#installation)
- [Configure MCP Server](#configure-mcp-server)
- [Connect From Tests](#connect-from-tests)
- [MCP Tools](#mcp-tools)
- [Context and Available APIs](#context-and-available-apis)
- [Multi-Client Architecture](#multi-client-architecture)
- [CLI Commands](#cli-commands)
- [Environment Variables](#environment-variables)
- [FAQ](#faq)
- [How It Works](#how-it-works)

## Quick Start

**Step 1: Install**

```bash
npm install -D testing-mcp
```

**Step 2: Configure Model Context Protocol (MCP) server** (e.g., in Claude Desktop config):

```json
{
  "testing-mcp": {
    "command": "npx",
    "args": ["-y", "testing-mcp@latest"]
  }
}
```

**Step 3: Connect from your test:**

```ts
import { render, screen, fireEvent } from "@testing-library/react";
import { connect } from "testing-mcp";

it("your test", async () => {
  render(<YourComponent />);
  await connect({
    context: { screen, fireEvent },
  });
}, 600000); // 10 minute timeout for AI interaction
```

**Step 4: Run with MCP enabled:**

Prompt:

```
Please run the persistent test in the `examples/react-jest` directory:

`TESTING_MCP=true RTL_SKIP_AUTO_CLEANUP=true npm test test/App.test.tsx`

Then, use the `testing-mcp` tool to write the test by following these steps:

1. Click the button displaying "count is 0".
2. Verify that the button text changes to "count is 1".
3. Write the test code to a file.
```

Now your AI assistant can see the page structure, execute code in the test, and help you write assertions.

## Why Testing MCP

Traditional test writing is slow and frustrating:

- **Write → Run → Read errors → Guess → Repeat** - endless debugging cycles
- **Add `console.log` statements manually** - slow feedback loop
- **AI assistants can't see your test state** - you must describe everything
- **Must manually explain available APIs** - AI generates invalid code

**Testing MCP solves this** by giving AI assistants live access to your test environment:

- **AI sees** actual page structure (DOM), console logs, and rendered output
- **AI executes** code directly in tests without editing files
- **AI knows** exactly which testing APIs are available (screen, fireEvent, etc.)
- **You iterate faster** with real-time feedback instead of blind guessing

## What Testing MCP Does

### 🔍 **Real-Time Test Inspection**

**View live page structure snapshots, console logs, and test metadata** through MCP tools. No more adding temporary `console.log` statements or running tests repeatedly.

### 🎯 **Remote Code Execution**

**Execute JavaScript/TypeScript directly in your running test environment.** Test interactions, check page state, or run assertions without modifying test files.

### 🧠 **Smart Context Awareness**

**Automatically collects and exposes available testing APIs** (like `screen`, `fireEvent`, `waitFor`) with type information and descriptions. AI assistants know exactly what's available and generate valid code on the first try.

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

**Reliable WebSocket connections** with session tracking, reconnection support, and automatic cleanup. Multiple tests can connect simultaneously.

### 🚫 **Zero CI Overhead**

**Automatically disabled in continuous integration (CI) environments.** The `connect()` call becomes a no-op when `TESTING_MCP` is not set(particularly utilised hooks), so your tests run normally in production.

### 🤖 **AI-First Design**

**Built specifically for AI assistants and the Model Context Protocol.** Provides structured metadata, clear tool descriptions, and predictable responses optimized for AI understanding.

### 🔀 **Multi-Client Support**

**Run multiple MCP clients simultaneously** (Claude Desktop, Cursor, VS Code, etc.) without port conflicts. The daemon architecture automatically manages connections and port allocation.

## Installation

Install dependencies and build the project before launching the MCP server or consuming the client helper.

```bash
npm install -D testing-mcp
# or
yarn add -D testing-mcp
# or
pnpm add -D testing-mcp
```

**Node 18+** is required because the project uses ES modules and the WebSocket API.

## Configure MCP Server

Add the MCP server to your AI assistant's configuration (e.g., Claude Desktop, VSCode, etc.):

```json
{
  "testing-mcp": {
    "command": "npx",
    "args": ["-y", "testing-mcp@latest"]
  }
}
```

The server automatically discovers and connects to the bridge daemon, which manages WebSocket connections on dynamically assigned ports.

## Connect From Tests

Import the client helper in your Jest or Vitest suites hook to expose the page state to the MCP server.

**Example Jest setup file(`setupFilesAfterEnv`)**

```ts
// jest.setup.ts
import { screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { connect } from "testing-mcp";

const timeout = 10 * 60 * 1000;

if (process.env.TESTING_MCP) {
  jest.setTimeout(timeout);
}

afterEach(async () => {
  if (!process.env.TESTING_MCP) return;
  const state = expect.getState();
  await connect({
    filePath: state.testPath,
    context: {
      userEvent,
      screen,
      fireEvent,
    },
  });
}, timeout);
```

It also supports usage in test files:

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
      filePath: import.meta.url,
      context: {
        screen,
        fireEvent,
        userEvent,
        waitFor,
      },
      // Optional: provide descriptions to help LLMs understand the APIs
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

> If the DOM has been automatically cleared after the `afterEach` hook executes, please set `RTL_SKIP_AUTO_CLEANUP=true`.

## MCP Tools

Once connected, your AI assistant can use these tools:

| Tool                     | Purpose                                                | When to Use                                         |
| ------------------------ | ------------------------------------------------------ | --------------------------------------------------- |
| `get_current_test_state` | Fetch current page structure, console logs, and APIs   | Inspect what's rendered and what APIs are available |
| `execute_test_step`      | Run JavaScript/TypeScript code in the test environment | Trigger interactions, check state, run assertions   |
| `finalize_test`          | Remove `connect()` call and clean up test file         | After test is complete and working                  |
| `list_active_tests`      | Show all connected tests with timestamps               | See which tests are available                       |
| `get_generated_code`     | Extract code blocks inserted by the helper             | Audit what code was added                           |

### `get_current_test_state`

Returns the current test state including:

- **Page structure snapshot**: Current rendered HTML (DOM)
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

### `execute_test_step`

Executes JavaScript/TypeScript code in the connected test client. The code can use any APIs listed in the `availableContext` field from `get_current_test_state`.

**Best Practice**: Always call `get_current_test_state` first to check which APIs are available before using `execute_test_step`.

## Context and Available APIs

**Inject testing utilities so AI knows what's available:**

The `connect()` function accepts a `context` object that exposes APIs to the test execution environment. This allows AI assistants to know exactly what APIs are available when generating code.

### Basic Usage

```ts
await connect({
  context: {
    screen, // React Testing Library queries
    fireEvent, // DOM event triggering
    userEvent, // User interaction simulation
    waitFor, // Async waiting utility
  },
});
```

### Adding Descriptions (Recommended)

Provide descriptions for each context key to help AI understand what's available:

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
    screen: "Query methods like getByText, findByRole, etc.",
    fireEvent: "Trigger DOM events: click, change, etc.",
    waitFor: "Wait for assertions: waitFor(() => expect(...).toBe(...))",
    customHelper: "async (text: string) => void - Clicks button by text",
  },
});
```

**How it works:** The client collects metadata (name, type, function signature) for each context key. When AI calls `get_current_test_state`, it receives the full list of available APIs with their metadata, enabling accurate code generation.

## Multi-Client Architecture

Testing MCP v0.4.0 introduces a **Daemon + Adapter architecture** that allows multiple MCP clients to work simultaneously without port conflicts.

### How It Works

```
┌─────────────────────────────────────────────────────────────────┐
│  MCP Client A (Claude Desktop)                                  │
│         ↓                                                       │
│  testing-mcp serve (Adapter A) ──┐                              │
└─────────────────────────────────────────────────────────────────┘
                                   │
┌─────────────────────────────────────────────────────────────────┐
│  MCP Client B (Cursor)                                          │
│         ↓                                                       │
│  testing-mcp serve (Adapter B) ──┼── RPC ──→ Bridge Daemon      │
└─────────────────────────────────────────────────────────────────┘
                                   │          (Single Instance)
┌─────────────────────────────────────────────────────────────────┘
│  MCP Client C (VS Code)                                         │
│         ↓                                                       │
│  testing-mcp serve (Adapter C) ──┘               │              │
└─────────────────────────────────────────────────────────────────┘
                                                   ↓
                                         ┌─────────────────────────┐
                                         │  Test Client            │
                                         │  await connect()        │
                                         │  (Auto-discovers port)  │
                                         └─────────────────────────┘
```

### Components

| Component         | Description                                                                                           |
| ----------------- | ----------------------------------------------------------------------------------------------------- |
| **Bridge Daemon** | Single background process that manages WebSocket connections from tests. Automatically assigns ports. |
| **MCP Adapter**   | Lightweight stdio MCP server that each client spawns. Communicates with daemon via RPC.               |
| **Registry File** | `~/.testing-mcp/bridge.json` - Contains daemon port and auth token for auto-discovery.                |

### Auto-Discovery

Test clients automatically discover the daemon's WebSocket port by reading the registry file. No manual port configuration required:

```ts
// Port auto-discovered from ~/.testing-mcp/bridge.json
await connect({
  context: { screen, fireEvent },
});
```

### Manual Daemon Management (Optional)

The daemon starts automatically when needed. For manual control:

```bash
# Start daemon manually
testing-mcp bridge

# Check daemon status
testing-mcp bridge status

# Diagnose daemon registry and connectivity
testing-mcp bridge doctor --json

# Stop daemon
testing-mcp bridge stop
```

## CLI Commands

```bash
testing-mcp [command] [options]

Commands:
  serve          Run as MCP adapter via stdio (default)
  bridge         Start the bridge daemon
  bridge stop    Stop the running daemon
  bridge status  Show daemon status
  bridge doctor  Diagnose daemon registry and connectivity

Options:
  --help, -h     Show this help message
  --version, -v  Show version number
```

### Examples

```bash
# Run as MCP server (for MCP client configuration)
testing-mcp

# Start the bridge daemon (for multi-client support)
testing-mcp bridge

# Check daemon status
testing-mcp bridge status
# Output:
# Status: Running
#   PID:           12345
#   WebSocket:     ws://127.0.0.1:53718
#   RPC:           ws://127.0.0.1:53719
#   Version:       0.5.2
#   Uptime:        5m 32s
#   Connections:   2

# Diagnose daemon health without printing secrets
testing-mcp bridge doctor --json

# Stop the daemon
testing-mcp bridge stop
```

## Environment Variables

- **`TESTING_MCP`**: When set to `true`, enables the WebSocket bridge to the MCP server. Leave unset to disable (automatically disabled in CI environments).
- **`TESTING_MCP_PORT`**: Overrides the WebSocket port for test clients. In most cases, this is not needed as ports are auto-discovered from the daemon registry.
- **`TESTING_MCP_TOKEN`**: Authentication token to use with an explicit `TESTING_MCP_PORT` or `connect({ port })` override.
- **`TESTING_MCP_DATA_DIR`**: Overrides the daemon registry directory. Use this to isolate multiple workspaces or exploratory testing sessions.

### Port Resolution Priority

The `connect()` function resolves the WebSocket port in this order:

1. **Explicit `port` option**: `connect({ port: 3001 })`
2. **Environment variable**: `TESTING_MCP_PORT=3001`
3. **Registry file**: Auto-discovered from `~/.testing-mcp/bridge.json`
4. **Default fallback**: `3001`

## FAQ

### 1. How do I view MCP errors?

If you see that testing-mcp fails to start in Cursor IDE, you can check detailed logs:

**In Cursor IDE:** Go to **Output > MCP:user-testing-mcp** to see detailed error information.

This will show you the exact error messages and help diagnose startup issues.

### 2. What if the port is already in use?

**With the new daemon architecture (v0.4.0+), port conflicts are automatically resolved.** The daemon uses dynamic port allocation (`port=0`), so it always finds an available port.

If you're using an older version or manual port configuration:

1. Upgrade to v0.4.0+ for automatic port management
2. Or kill the process using the port:

```bash
# macOS/Linux
lsof -ti:3001 | xargs kill -9
```

### 3. Can I run multiple MCP clients simultaneously?

**Yes!** The daemon architecture (v0.4.0+) supports multiple MCP clients:

- Claude Desktop, Cursor, VS Code can all connect at the same time
- Each adapter connects to the shared daemon via RPC
- No port conflicts - the daemon handles all connections

### 4. Why shouldn't I use watch mode?

**Testing MCP currently supports only one WebSocket connection per test at a time.**

When your MCP client runs the same test command multiple times (like in watch mode), each run creates a new WebSocket connection. This can cause conflicts and unexpected behavior.

**Recommendation:** Run tests individually without watch mode when using `TESTING_MCP=true`.

### 5. My tests timeout immediately - what's wrong?

If tests with `TESTING_MCP=true` timeout quickly, **you need to increase the test timeout.**

AI assistants need time to inspect state and write tests - usually **5+ minutes minimum**.

**Set timeout in your test:**

```ts
it("your test", async () => {
  render(<YourComponent />);
  await connect({ context: { screen, fireEvent } });
}, 600000); // 10 minutes = 600000ms
```

### 6. Can I put `connect()` in a test setup file instead of each test?

**Yes, if your tests don't automatically clear the DOM between tests.**

By placing `connect()` in an `afterEach` hook in your setup file, you can make testing completely non-invasive and easier for automated test writing.

**Example Jest setup file(`setupFilesAfterEnv`)**

```ts
// jest.setup.ts
import { screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { connect } from "testing-mcp";

const timeout = 10 * 60 * 1000;

if (process.env.TESTING_MCP) {
  jest.setTimeout(timeout);
}

afterEach(async () => {
  if (!process.env.TESTING_MCP) return;
  const state = expect.getState();
  await connect({
    filePath: state.testPath,
    context: {
      userEvent,
      screen,
      fireEvent,
    },
  });
}, timeout);
```

**Example Vitest setup file(`setupFiles`):**

```ts
// vitest.setup.ts
import { beforeEach, afterEach, expect } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { connect } from "testing-mcp";

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
    filePath: state.testPath,
    context: {
      userEvent,
      screen,
      expect,
      fireEvent,
    },
  });
}, timeout);
```

**Important:** This approach only works if your `afterEach` hooks don't automatically remove the DOM (e.g., you're not calling `cleanup()` before `connect()`).

### 7. Where is the daemon registry file located?

The registry file stores daemon connection info for auto-discovery:

| Platform    | Path                                     |
| ----------- | ---------------------------------------- |
| macOS/Linux | `~/.testing-mcp/bridge.json`             |
| Windows     | `%LOCALAPPDATA%\testing-mcp\bridge.json` |

Set `TESTING_MCP_DATA_DIR=/path/to/session/.testing-mcp` to place the registry
and lock file in a session-scoped directory.

**Example registry content:**

```json
{
  "pid": 12345,
  "wsPort": 53718,
  "rpcPort": 53719,
  "token": "abc123...",
  "startedAt": "2024-01-15T10:30:00.000Z",
  "version": "0.5.2",
  "protocol": 1
}
```

## How It Works

Testing MCP uses a **Daemon + Adapter architecture** for robust multi-client support:

### Architecture Overview

```
┌──────────────────┐         ┌──────────────────┐         ┌──────────────────┐
│  Node.js Test    │         │  Bridge Daemon   │         │   LLM/MCP        │
│    Process       │         │    (Singleton)   │         │     Client       │
└────────┬─────────┘         └────────┬─────────┘         └────────┬─────────┘
         │                            │                            │
         │                            │         ┌──────────────────┤
         │                            │         │  MCP Adapter     │
         │                            │◄────────┤  (per client)    │
         │                            │   RPC   └──────────────────┘
         │                            │                            │
         │  1. await connect()        │                            │
         ├───────────────────────────►│                            │
         │   (Auto-discovers port)    │                            │
         │                            │                            │
         │  2. WebSocket: "ready"     │   3. MCP Tool Call         │
         │    {dom, logs, context}    │      (Stdio/JSON-RPC)      │
         ├───────────────────────────►│◄───────────────────────────┤
         │                            │                            │
         │  4. "connected"            │   5. RPC: getCurrentState  │
         │    {sessionId}             │◄───────────────────────────┤
         │◄───────────────────────────┤                            │
         │                            │   6. Returns state         │
         │      Test waits...         ├───────────────────────────►│
         │                            │                            │
         │                            │   7. RPC: sendExecute      │
         │  8. "execute"              │◄───────────────────────────┤
         │    {code, executionId}     │                            │
         │◄───────────────────────────┤                            │
         │                            │                            │
         │  Runs code with context    │                            │
         │                            │                            │
         │  9. "executed"             │                            │
         │    {result, newState}      │   10. Returns result       │
         ├───────────────────────────►├───────────────────────────►│
         │                            │                            │
         │                            │   11. finalize_test        │
         │  12. "close"               │◄───────────────────────────┤
         │◄───────────────────────────┤   (Adapter edits file)     │
         │                            │                            │
         │  Test completes            │   13. Returns success      │
         │                            ├───────────────────────────►│
         ▼                            ▼                            ▼
```

### Key Components

| Component         | Responsibility                                                                      |
| ----------------- | ----------------------------------------------------------------------------------- |
| **Bridge Daemon** | Singleton process managing WebSocket connections, session state, and code execution |
| **MCP Adapter**   | Per-client stdio MCP server that forwards tool calls to daemon via RPC              |
| **Registry File** | Stores daemon port/token for auto-discovery by adapters and test clients            |
| **Test Client**   | `connect()` function that establishes WebSocket to daemon                           |

### Protocol Summary

| Communication    | Protocol       | Purpose                    |
| ---------------- | -------------- | -------------------------- |
| Test ↔ Daemon    | WebSocket      | State sync, code execution |
| Adapter ↔ Daemon | WebSocket RPC  | Tool call forwarding       |
| Client ↔ Adapter | Stdio JSON-RPC | MCP protocol               |

### Benefits of This Architecture

1. **No port conflicts**: Daemon uses dynamic port allocation
2. **Multi-client support**: Multiple AI assistants can connect simultaneously
3. **Auto-discovery**: Test clients find daemon automatically via registry
4. **Graceful lifecycle**: Daemon starts on-demand, can be managed manually
5. **Security**: Token-based authentication between components

## License

MIT
