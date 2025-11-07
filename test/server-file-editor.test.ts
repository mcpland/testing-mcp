import { mkdtemp, readFile, rm, writeFile, access } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FileEditor } from "../src/server/fileEditor.ts";

const baseTestContent = `
import { connect } from "testing-mcp/client";

test("demo", async () => {
  // >>>> TESTING-MCP:BEGIN step-1
  await connect({ port: 3001 });
  const intermediate = 1;
  // >>>> TESTING-MCP:END

  // >>>> TESTING-MCP:BEGIN step-2
  const another = intermediate + 1;
  // >>>> TESTING-MCP:END
});
`.trimStart();

describe("FileEditor", () => {
  let editor: FileEditor;
  let tempDir: string;
  let testFile: string;

  beforeEach(async () => {
    editor = new FileEditor();
    tempDir = await mkdtemp(path.join(tmpdir(), "file-editor-"));
    testFile = path.join(tempDir, "example.test.tsx");
    await writeFile(testFile, baseTestContent, "utf-8");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  async function resetFile(content: string = baseTestContent) {
    await writeFile(testFile, content, "utf-8");
  }

  it("detects and removes connect calls safely", async () => {
    expect(await editor.hasConnectCall(testFile)).toBe(true);

    await editor.removeConnect(testFile);

    const updated = await readFile(testFile, "utf-8");
    expect(updated).not.toContain("await connect");
    expect(await editor.hasConnectCall(testFile)).toBe(false);
  });

  it("ignores removal when connect call is absent", async () => {
    await resetFile(
      `
      test("no connect", () => {
        expect(true).toBe(true);
      });
      `
    );

    await expect(editor.removeConnect(testFile)).resolves.toBeUndefined();
    expect(await editor.hasConnectCall(testFile)).toBe(false);
  });

  it("collects generated code blocks between markers", async () => {
    const generated = await editor.getGeneratedCode(testFile);
    expect(generated).toHaveLength(2);
    expect(generated[0]).toContain("await connect");
    expect(generated[1]).toContain("const another");
  });

  it("removes testing markers while keeping inner code intact", async () => {
    await editor.removeMarkers(testFile);
    const content = await readFile(testFile, "utf-8");

    expect(content).not.toContain("TESTING-MCP:BEGIN");
    expect(content).not.toContain("TESTING-MCP:END");
    expect(content).toContain("const intermediate = 1;");
    expect(content).toContain("const another = intermediate + 1;");
  });

  it("backs up and restores test files", async () => {
    await editor.backupFile(testFile);
    await writeFile(testFile, "// modified", "utf-8");

    await editor.restoreFromBackup(testFile);

    const restored = await readFile(testFile, "utf-8");
    expect(restored).toContain("await connect");

    await expect(access(`${testFile}.backup`)).rejects.toBeInstanceOf(Error);
  });

  it("serializes concurrent operations using file locks", async () => {
    await Promise.all([
      editor.removeMarkers(testFile),
      editor.removeMarkers(testFile),
      editor.removeConnect(testFile),
    ]);

    const finalContent = await readFile(testFile, "utf-8");
    expect(finalContent).not.toContain("TESTING-MCP");
  });
});
