import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";

const originalEnv = { ...process.env };

describe("daemon registry health", () => {
  let dataDir: string;
  let registryPath: string;

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "testing-mcp-registry-"));
    process.env = {
      ...originalEnv,
      TESTING_MCP_DATA_DIR: dataDir,
    };
    registryPath = path.join(dataDir, "bridge.json");
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    await fs.rm(dataDir, { force: true, recursive: true });
  });

  it("cleans up a registry whose process exists but RPC is unreachable", async () => {
    await fs.writeFile(
      registryPath,
      JSON.stringify({
        pid: process.pid,
        protocol: 1,
        rpcPort: 65534,
        startedAt: new Date().toISOString(),
        token: "test-token",
        version: "0.5.2",
        wsPort: 65533,
      })
    );

    const { isDaemonRunning } = await import("../src/daemon/registry.ts");

    await expect(isDaemonRunning()).resolves.toBeNull();
    await expect(fs.access(registryPath)).rejects.toThrow();
  });

  it("reports unhealthy registry details without cleanup", async () => {
    await fs.writeFile(
      registryPath,
      JSON.stringify({
        pid: process.pid,
        protocol: 1,
        rpcPort: 65534,
        startedAt: new Date().toISOString(),
        token: "test-token",
        version: "0.5.2",
        wsPort: 65533,
      })
    );

    const { checkDaemonHealth } = await import("../src/daemon/registry.ts");

    const health = await checkDaemonHealth({ cleanup: false });

    expect(health).toMatchObject({
      healthy: false,
      pidAlive: true,
      protocolCompatible: true,
      registryPath,
      rpcReachable: false,
    });
    await expect(fs.access(registryPath)).resolves.toBeUndefined();
  });
});
