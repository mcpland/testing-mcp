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
- [Available MCP Tools](#available-mcp-tools)
- [Context and Available APIs](#context-and-available-apis)
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
Please run the persistent test: `TESTING_MCP=true npm test test/example.test.tsx`,

Then use testing-mcp to write the test in `test/example.test.tsx` with these steps:
1. Click the “count” button.
2. Verify that the number on the count button becomes “1”.
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

**Automatically disabled in continuous integration (CI) environments.** The `connect()` call becomes a no-op when `TESTING_MCP` is not set, so your tests run normally in production.

### 🤖 **AI-First Design**

**Built specifically for AI assistants and the Model Context Protocol.** Provides structured metadata, clear tool descriptions, and predictable responses optimized for AI understanding.

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

The server opens a WebSocket bridge on port `3001` (configurable) and registers MCP tools for state inspection, file editing, and remote code execution.

## Connect From Tests

Import the client helper in your Vitest or Jest suites to expose the page state to the MCP server.

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

## Available MCP Tools

Once connected, your AI assistant can use these tools:

| Tool                     | Purpose                                                    | When to Use                                     |
| ------------------------ | ---------------------------------------------------------- | ----------------------------------------------- |
| `get_current_test_state` | Fetch current page structure, console logs, and APIs       | Inspect what's rendered and what APIs are available |
| `execute_test_step`      | Run JavaScript/TypeScript code in the test environment     | Trigger interactions, check state, run assertions |
| `finalize_test`          | Remove `connect()` call and clean up test file             | After test is complete and working              |
| `list_active_tests`      | Show all connected tests with timestamps                   | See which tests are available                   |
| `get_generated_code`     | Extract code blocks inserted by the helper                 | Audit what code was added                       |

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
    screen,      // React Testing Library queries
    fireEvent,   // DOM event triggering
    userEvent,   // User interaction simulation
    waitFor,     // Async waiting utility
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

## Environment Variables

- **`TESTING_MCP`**: When set to `true`, enables the WebSocket bridge to the MCP server. Leave unset to disable (automatically disabled in CI environments).
- **`TESTING_MCP_PORT`**: Overrides the WebSocket port. Defaults to `3001`. Set this if the default port is occupied or you want multiple servers running.

**Custom port example:**

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

## FAQ

### 1. How do I view MCP errors?

If you see that testing-mcp fails to start in Cursor IDE, you can check detailed logs:

**In Cursor IDE:** Go to **Output > MCP:user-testing-mcp** to see detailed error information.

This will show you the exact error messages and help diagnose startup issues.

### 2. What if the port is already in use?

**Each MCP client instance needs a unique port.** If you want to run multiple testing-mcp instances simultaneously:

1. Set different `TESTING_MCP_PORT` values for each instance in MCP server config.
2. Pass the same port number to the `connect()` function in your tests

```ts
// In your test
await connect({
  port: 4001, // Match your custom port
  context: { screen, fireEvent },
});
```

**For example, kill a process using the default port (macOS):**

```bash
lsof -ti:3001 | xargs kill -9
```

### 3. Why shouldn't I use watch mode?

**Testing MCP currently supports only one WebSocket connection per test at a time.**

When your MCP client runs the same test command multiple times (like in watch mode), each run creates a new WebSocket connection. This can cause conflicts and unexpected behavior.

**Recommendation:** Run tests individually without watch mode when using `TESTING_MCP=true`.

### 4. My tests timeout immediately - what's wrong?

If tests with `TESTING_MCP=true` timeout quickly, **you need to increase the test timeout.**

AI assistants need time to inspect state and write tests - usually **5+ minutes minimum**.

**Set timeout in your test:**

```ts
it("your test", async () => {
  render(<YourComponent />);
  await connect({ context: { screen, fireEvent } });
}, 600000); // 10 minutes = 600000ms
```

### 5. Can I put `connect()` in a test setup file instead of each test?

**Yes, if your tests don't automatically clear the DOM between tests.**

By placing `connect()` in an `afterEach` hook in your setup file, you can make testing completely non-invasive and easier for automated test writing.

**Example Jest setup file:**

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
    port: 3001,
    filePath: state.testPath,
    context: {
      userEvent,
      screen,
      fireEvent,
    },
  });
}, timeout);
```

**Example Vitest setup file:**

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
```

**Important:** This approach only works if your `afterEach` hooks don't automatically remove the DOM (e.g., you're not calling `cleanup()` before `connect()`).

## How It Works

Testing MCP uses a three-process architecture:

- **Test process** calls `connect()` to send page snapshots, console logs, and metadata to the server
- **MCP server** manages WebSocket connections, stores session state, and exposes MCP tools via Stdio
- **AI assistant** calls MCP tools to inspect state and execute code remotely

Communication stays resilient to reconnections by tracking per-session UUIDs and cleaning up callbacks on close.

### Process Interaction Sequence Diagram

The system consists of three independent processes that communicate through two different protocols:

```
┌──────────────────┐         ┌──────────────────┐         ┌──────────────────┐
│  Node.js Test    │         │   MCP Server     │         │   LLM/MCP        │
│    Process       │         │    Process       │         │     Client       │
└────────┬─────────┘         └────────┬─────────┘         └────────┬─────────┘
         │                            │                            │
         │                            │◄───────────────────────────┤
         │                            │   1. MCP Tool Call         │
         │                            │   (via Stdio/JSON-RPC)     │
         │                            │                            │
         │  2. await connect()        │                            │
         ├───────────────────────────►│                            │
         │   Collects DOM & context   │                            │
         │                            │                            │
         │  3. WebSocket: "ready"     │                            │
         │    {dom, logs, context}    │                            │
         ├───────────────────────────►│                            │
         │                            │   Stores session state     │
         │                            │                            │
         │  4. "connected"            │                            │
         │    {sessionId}             │                            │
         │◄───────────────────────────┤                            │
         │                            │                            │
         │      Test waits...         │   5. Returns state         │
         │                            ├───────────────────────────►│
         │                            │   {dom, logs, context}     │
         │                            │                            │
         │                            │◄───────────────────────────┤
         │                            │   6. execute_test_step     │
         │                            │   {code, sessionId}        │
         │                            │                            │
         │  7. "execute"              │                            │
         │    {code, executionId}     │                            │
         │◄───────────────────────────┤                            │
         │                            │                            │
         │  Runs code with            │                            │
         │  available context         │                            │
         │  (screen, fireEvent...)    │                            │
         │                            │                            │
         │  8. "executed"             │                            │
         │    {result, newState}      │                            │
         ├───────────────────────────►│                            │
         │                            │   9. Returns result        │
         │                            ├───────────────────────────►│
         │      Test waits...         │   {result, newState}       │
         │                            │                            │
         │                            │◄───────────────────────────┤
         │                            │   10. finalize_test        │
         │                            │                            │
         │  11. "close"               │   Removes connect() call   │
         │◄───────────────────────────┤   from test file (AST)     │
         │                            │                            │
         │  Closes WebSocket          │                            │
         │  Test completes            │                            │
         │                            │   12. Returns success      │
         │                            ├───────────────────────────►│
         ▼                            ▼                            ▼

Protocol Summary:
─────────────────
• Test Process ←→ MCP Server: WebSocket (port 3001)
  Message types: ready, connected, execute, executed, close

• MCP Server ←→ LLM Client: Stdio/JSON-RPC (MCP Protocol)
  Tools: get_current_test_state, execute_test_step, finalize_test,
         list_active_tests, get_generated_code
```

### Key Interactions

1. **AI initiates**: AI assistant calls MCP tools via Stdio to interact with tests
2. **Test connects**: Test process calls `await connect()` which establishes WebSocket to MCP server
3. **Bidirectional sync**: Test sends state updates; server executes code remotely
4. **Session tracking**: Each test gets unique `sessionId` for managing multiple concurrent connections
5. **Automatic cleanup**: Server uses Abstract Syntax Tree (AST) manipulation to remove `connect()` calls when finalizing

## License

MIT
