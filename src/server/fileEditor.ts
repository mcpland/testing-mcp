/**
 * Server Side: File Editor
 * Uses AST manipulation to inject code into test files
 */

import {
  Project,
  SourceFile,
  SyntaxKind,
  Node,
  ExpressionStatement,
} from "ts-morph";
import * as fs from "fs/promises";
import * as path from "path";

export interface InsertCodeOptions {
  comment?: string;
  stepNumber?: number;
  useMarkers?: boolean; // Use TESTING-MCP:BEGIN/END markers
}

export class FileEditor {
  private project: Project;
  private fileLocks = new Map<string, Promise<void>>();

  constructor() {
    this.project = new Project({
      useInMemoryFileSystem: false,
      skipAddingFilesFromTsConfig: true,
    });
  }

  /**
   * Remove the connect() call from the test file
   */
  async removeConnect(testFile: string): Promise<void> {
    return this.withFileLock(testFile, async () => {
      const sourceFile = this.project.addSourceFileAtPath(testFile);

      try {
        const connectCall = this.findConnectCall(sourceFile);

        if (!connectCall) {
          console.error(`[testing-mcp] No connect() call found in ${testFile}`);
          return;
        }

        // Remove the entire statement
        let connectStatement: Node | undefined = connectCall.getParent();
        while (
          connectStatement &&
          connectStatement.getKind() !== SyntaxKind.ExpressionStatement
        ) {
          connectStatement = connectStatement.getParent();
        }

        if (connectStatement) {
          (connectStatement as ExpressionStatement).remove();
        }

        await sourceFile.save();

        console.error(`[testing-mcp] Removed connect() from ${testFile}`);
      } finally {
        this.project.removeSourceFile(sourceFile);
      }
    });
  }

  /**
   * Remove all TESTING-MCP markers
   */
  async removeMarkers(testFile: string): Promise<void> {
    return this.withFileLock(testFile, async () => {
      const content = await fs.readFile(testFile, "utf-8");

      // Remove marker comments but keep the code
      const lines = content.split("\n");
      const newLines: string[] = [];
      let inMarkerBlock = false;

      for (const line of lines) {
        if (line.includes("// >>>> TESTING-MCP:BEGIN")) {
          inMarkerBlock = true;
          continue; // Skip BEGIN marker
        }
        if (line.includes("// >>>> TESTING-MCP:END")) {
          inMarkerBlock = false;
          continue; // Skip END marker
        }

        // Keep all non-marker lines
        newLines.push(line);
      }

      await fs.writeFile(testFile, newLines.join("\n"), "utf-8");
      console.error(`[testing-mcp] Removed markers from ${testFile}`);
    });
  }

  /**
   * Check if file has connect() call
   */
  async hasConnectCall(testFile: string): Promise<boolean> {
    try {
      const sourceFile = this.project.addSourceFileAtPath(testFile);
      const hasConnect = this.findConnectCall(sourceFile) !== null;
      this.project.removeSourceFile(sourceFile);
      return hasConnect;
    } catch {
      return false;
    }
  }

  /**
   * Get the generated code region (between markers)
   */
  async getGeneratedCode(testFile: string): Promise<string[]> {
    const content = await fs.readFile(testFile, "utf-8");
    const lines = content.split("\n");
    const generatedBlocks: string[] = [];
    let currentBlock: string[] = [];
    let inMarkerBlock = false;

    for (const line of lines) {
      if (line.includes("// >>>> TESTING-MCP:BEGIN")) {
        inMarkerBlock = true;
        currentBlock = [];
        continue;
      }
      if (line.includes("// >>>> TESTING-MCP:END")) {
        inMarkerBlock = false;
        if (currentBlock.length > 0) {
          generatedBlocks.push(currentBlock.join("\n"));
        }
        continue;
      }

      if (inMarkerBlock) {
        currentBlock.push(line);
      }
    }

    return generatedBlocks;
  }

  /**
   * Find the connect() call in the source file
   */
  private findConnectCall(sourceFile: SourceFile) {
    // Look for await connect() or connect() calls
    const awaitExpressions = sourceFile.getDescendantsOfKind(
      SyntaxKind.AwaitExpression
    );

    for (const awaitExpr of awaitExpressions) {
      const callExpr = awaitExpr.getExpression();

      if (callExpr.getKind() === SyntaxKind.CallExpression) {
        const callExpression = callExpr.asKindOrThrow(
          SyntaxKind.CallExpression
        );
        const expression = callExpression.getExpression();

        if (expression.getText() === "connect") {
          return callExpression;
        }
      }
    }

    return null;
  }

  /**
   * Get indentation at a specific line
   */
  private getIndentation(sourceFile: SourceFile, lineNumber: number): string {
    const line = sourceFile.getFullText().split("\n")[lineNumber - 1];
    const match = line?.match(/^(\s*)/);
    return match ? match[1] : "";
  }

  /**
   * Indent code with given indentation
   */
  private indentCode(code: string, indent: string): string {
    return code
      .split("\n")
      .map((line) => (line.trim() ? `${indent}${line}` : line))
      .join("\n");
  }

  /**
   * Update function with file lock to prevent concurrent modifications
   */
  private async withFileLock<T>(
    file: string,
    fn: () => Promise<T>
  ): Promise<T> {
    // Normalize file path
    const normalizedPath = path.resolve(file);

    // Wait for existing lock
    const existingLock = this.fileLocks.get(normalizedPath);
    if (existingLock) {
      await existingLock;
    }

    // Create new lock
    const newLock = (async () => {
      try {
        return await fn();
      } finally {
        this.fileLocks.delete(normalizedPath);
      }
    })();

    this.fileLocks.set(normalizedPath, newLock as Promise<void>);

    return newLock;
  }

  /**
   * Backup a file before modification
   */
  async backupFile(testFile: string): Promise<string> {
    const backupPath = `${testFile}.backup`;
    await fs.copyFile(testFile, backupPath);
    return backupPath;
  }

  /**
   * Restore from backup
   */
  async restoreFromBackup(testFile: string): Promise<void> {
    const backupPath = `${testFile}.backup`;
    try {
      await fs.copyFile(backupPath, testFile);
      await fs.unlink(backupPath);
      console.error(`[testing-mcp] Restored ${testFile} from backup`);
    } catch (error) {
      console.error(`[testing-mcp] Failed to restore from backup:`, error);
    }
  }
}
