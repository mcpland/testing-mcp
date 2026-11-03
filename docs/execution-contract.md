---
type: contract
title: Test-step results and session cancellation
description: Observable JavaScript results, console diagnostics, assertion failures and abortable test connections.
owner: NEEDS_OWNER
status: proposed
tags: [testing-mcp, execution, lifecycle]
---

# Test-step results and session cancellation

`execute_test_step` returns `success: false` and MCP `isError: true` when executed
code throws, including an assertion failure. Inspect `newState.errors` as well:
older clients may report failures there without structured execution data.
The connection remains usable, so a corrected step can run afterward.

Successful code can return a diagnostic value:

```js
console.log('created', api.writes().length);
return { creates: api.writes().length };
```

The response includes `result`, `newState.execution` (`executeId`, `success`,
optional `result` or `{name, message, stack}` error), a fresh DOM snapshot and
`newState.consoleLogs`. Logs contain type, diagnostic args and timestamp for
`log`, `info`, `warn`, `error` and `debug` during that step. Console methods are
forwarded and restored after success or failure. Steps in one process are
serialized so their DOM mutations and console capture do not overlap.

Results/log arguments are bounded snapshots. Cycles, accessors and unsupported
values receive explicit markers; getters and user-defined `toJSON` are not
called. Limits are six levels, 200 visited values, 50 entries per container,
4,000 characters per string, and 100 console records/64,000 serialized
characters plus a truncation marker. A missing return produces no `result`.
Capture covers the awaited execution interval; await your async work and use
RTL `act`/`waitFor` for meaningful assertions. This is diagnostic serialization,
not a JavaScript or filesystem security sandbox.

`connect({ signal })` supports `AbortSignal` across the initial async wait,
daemon discovery, WebSocket connection, connected session and retry backoff.
Cancellation rejects with `AbortError`, clears timers/session identity and
closes this connection. It does not remove another daemon's registry or stop
the daemon. An already aborted signal creates no socket. The test owner should
always dispose its mounted app and other mocks in `finally`.

Verification: `yarn build && yarn test`; focused contracts are
`test/execution.test.ts`, `test/adapter-execution.test.ts` and
`test/client-connect.test.ts`. These cover error propagation, return values,
console restoration, concurrent steps and cancellation at each lifecycle stage.
