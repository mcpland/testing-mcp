#!/usr/bin/env node

/**
 * Testing-MCP CLI
 * Main entry point supporting multiple modes:
 * - serve (default): Run as MCP adapter via stdio
 * - bridge: Run as daemon (WebSocket + RPC server)
 * - bridge stop: Stop running daemon
 * - bridge status: Show daemon status
 * - bridge doctor: Diagnose daemon registry and connectivity
 */

import { runAdapter } from "./adapter/index.js";
import { runDaemon, Daemon } from "./daemon/index.js";
import { checkDaemonHealth, isDaemonRunning, readRegistry, deleteRegistry } from "./daemon/registry.js";
import { VERSION } from "./shared/constants.js";
import { createBridgeClient } from "./adapter/bridgeClient.js";

/**
 * Print help message
 */
function printHelp(): void {
  console.log(`
testing-mcp v${VERSION}

Usage:
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

Examples:
  # Run as MCP server (for MCP client configuration)
  testing-mcp

  # Start the bridge daemon (for multi-client support)
  testing-mcp bridge

  # Check daemon status
  testing-mcp bridge status

  # Diagnose daemon health as JSON
  testing-mcp bridge doctor --json

  # Stop the daemon
  testing-mcp bridge stop

Architecture:
  The new daemon architecture supports multiple MCP clients simultaneously:

  1. The 'bridge' daemon manages all WebSocket connections from tests
  2. Each 'serve' instance (MCP adapter) connects to the daemon via RPC
  3. Test clients auto-discover the daemon's port via registry file

  This allows multiple AI assistants to work with tests concurrently
  without port conflicts.
`);
}

/**
 * Print version
 */
function printVersion(): void {
  console.log(`testing-mcp v${VERSION}`);
}

/**
 * Handle 'bridge' subcommand
 */
async function handleBridge(args: string[]): Promise<void> {
  const subCommand = args[0];

  switch (subCommand) {
    case "stop":
      await handleBridgeStop();
      break;

    case "status":
      await handleBridgeStatus();
      break;

    case "doctor":
      await handleBridgeDoctor(args.slice(1));
      break;

    case undefined:
    case "start":
      // Start daemon
      await runDaemon({ foreground: true });
      break;

    default:
      console.error(`Unknown bridge subcommand: ${subCommand}`);
      console.error("Use 'testing-mcp bridge --help' for usage information");
      process.exit(1);
  }
}

function wantsJson(args: string[]): boolean {
  return args.includes("--json");
}

async function handleBridgeDoctor(args: string[]): Promise<void> {
  const health = await checkDaemonHealth({
    cleanup: args.includes("--cleanup"),
  });
  const registry = health.registry
    ? {
        pid: health.registry.pid,
        protocol: health.registry.protocol,
        rpcPort: health.registry.rpcPort,
        startedAt: health.registry.startedAt,
        version: health.registry.version,
        wsPort: health.registry.wsPort,
      }
    : null;

  if (wantsJson(args)) {
    console.log(
      JSON.stringify(
        {
          healthy: health.healthy,
          pidAlive: health.pidAlive ?? false,
          protocolCompatible: health.protocolCompatible ?? false,
          reason: health.reason ?? null,
          registry,
          registryPath: health.registryPath,
          rpcReachable: health.rpcReachable ?? false,
        },
        null,
        2
      )
    );
    return;
  }

  console.log(`Status: ${health.healthy ? "Healthy" : "Unhealthy"}`);
  console.log("");
  console.log(`  Registry:      ${health.registryPath}`);
  console.log(`  PID alive:     ${health.pidAlive ?? false}`);
  console.log(`  Protocol ok:   ${health.protocolCompatible ?? false}`);
  console.log(`  RPC reachable: ${health.rpcReachable ?? false}`);

  if (registry) {
    console.log(`  PID:           ${registry.pid}`);
    console.log(`  WebSocket:     ws://127.0.0.1:${registry.wsPort}`);
    console.log(`  RPC:           ws://127.0.0.1:${registry.rpcPort}`);
    console.log(`  Version:       ${registry.version}`);
    console.log(`  Started:       ${registry.startedAt}`);
    console.log(`  Protocol:      v${registry.protocol}`);
  }

  if (health.reason) {
    console.log(`  Reason:        ${health.reason}`);
  }
}

/**
 * Stop the running daemon
 */
async function handleBridgeStop(): Promise<void> {
  const registry = await readRegistry();

  if (!registry) {
    console.log("No daemon is running");
    return;
  }

  try {
    // Try to gracefully shutdown via RPC
    const client = await createBridgeClient({ autoStartDaemon: false });
    await client.shutdown();
    console.log("Daemon shutdown requested");

    // Wait a moment for shutdown
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Verify shutdown
    const stillRunning = await isDaemonRunning();
    if (stillRunning) {
      console.log("Daemon is still running, sending SIGTERM...");
      try {
        process.kill(registry.pid, "SIGTERM");
      } catch {
        // Process may already be gone
      }
    }

    // Clean up registry
    await deleteRegistry();
    console.log("Daemon stopped");
  } catch (error) {
    // RPC failed, try direct kill
    console.log("Daemon not responding to RPC, sending SIGTERM...");
    try {
      process.kill(registry.pid, "SIGTERM");
      await deleteRegistry();
      console.log("Daemon stopped");
    } catch {
      console.error("Failed to stop daemon");
      process.exit(1);
    }
  }
}

/**
 * Show daemon status
 */
async function handleBridgeStatus(): Promise<void> {
  const registry = await isDaemonRunning();

  if (!registry) {
    console.log("Status: Not running");
    console.log("");
    console.log("Start the daemon with: testing-mcp bridge");
    return;
  }

  console.log("Status: Running");
  console.log("");
  console.log(`  PID:           ${registry.pid}`);
  console.log(`  WebSocket:     ws://127.0.0.1:${registry.wsPort}`);
  console.log(`  RPC:           ws://127.0.0.1:${registry.rpcPort}`);
  console.log(`  Version:       ${registry.version}`);
  console.log(`  Started:       ${registry.startedAt}`);
  console.log(`  Protocol:      v${registry.protocol}`);

  // Try to get more info from daemon
  try {
    const client = await createBridgeClient({ autoStartDaemon: false });
    const ping = await client.ping();
    const { connections } = await client.listConnections();

    console.log("");
    console.log(`  Uptime:        ${formatUptime(ping.uptime)}`);
    console.log(`  Connections:   ${connections.length}`);

    if (connections.length > 0) {
      console.log("");
      console.log("  Active tests:");
      for (const conn of connections) {
        console.log(`    - ${conn.testFile}: ${conn.testName}`);
      }
    }

    client.disconnect();
  } catch {
    // Could not connect to daemon for additional info
  }
}

/**
 * Format uptime in human-readable format
 */
function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}d ${hours % 24}h ${minutes % 60}m`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  // Handle flags
  if (command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "--version" || command === "-v") {
    printVersion();
    return;
  }

  // Handle commands
  switch (command) {
    case "serve":
    case undefined:
      // Default: run as MCP adapter
      await runAdapter();
      break;

    case "bridge":
      await handleBridge(args.slice(1));
      break;

    default:
      console.error(`Unknown command: ${command}`);
      console.error("Use 'testing-mcp --help' for usage information");
      process.exit(1);
  }
}

// Run main
main().catch((error) => {
  console.error("[testing-mcp] Fatal error:", error);
  process.exit(1);
});
