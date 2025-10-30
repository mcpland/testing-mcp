/**
 * Server Side: File Editor
 * Uses AST manipulation to inject code into test files
 */

import { Project, SourceFile, SyntaxKind, Node, ExpressionStatement } from 'ts-morph';
import * as fs from 'fs/promises';
import * as path from 'path';

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
      skipAddingFilesFromTsConfig: true
    });
  }

  /**
   * Insert code before the connect() call
   */
  async insertCodeBeforeConnect(
    testFile: string,
    code: string,
    options: InsertCodeOptions = {}
  ): Promise<void> {
    return this.withFileLock(testFile, async () => {
      const sourceFile = this.project.addSourceFileAtPath(testFile);
      
      try {
        // Find the connect() call
        const connectCall = this.findConnectCall(sourceFile);
        
        if (!connectCall) {
          throw new Error(`Could not find await connect() call in ${testFile}`);
        }

        // Get the indentation of the connect() call
        const indent = this.getIndentation(sourceFile, connectCall.getStartLineNumber());
        
        // Prepare the code to insert
        let codeToInsert = code;
        
        // Add markers if requested
        if (options.useMarkers && options.stepNumber !== undefined) {
          const comment = options.comment || `Step ${options.stepNumber}`;
          codeToInsert = `
${indent}// >>>> TESTING-MCP:BEGIN ${options.stepNumber} <<<<
${indent}// ${comment}
${this.indentCode(code, indent)}
${indent}// >>>> TESTING-MCP:END ${options.stepNumber} <<<<
`.trimStart();
        } else if (options.comment) {
          codeToInsert = `${indent}// ${options.comment}\n${this.indentCode(code, indent)}`;
        } else {
          codeToInsert = this.indentCode(code, indent);
        }
        
        // Insert the code before connect() call
        // The connect() call might be wrapped in an await expression
        let connectStatement: Node | undefined = connectCall.getParent();
        while (connectStatement && connectStatement.getKind() !== SyntaxKind.ExpressionStatement) {
          connectStatement = connectStatement.getParent();
        }
        
        if (!connectStatement) {
          throw new Error('Could not find ExpressionStatement parent for connect() call');
        }
        
        (connectStatement as ExpressionStatement).replaceWithText(`${codeToInsert}\n${indent}${connectStatement.getText()}`);
        
        // Save the file
        await sourceFile.save();
        
        console.error(`[testing-mcp] Inserted code into ${testFile}`);
      } finally {
        this.project.removeSourceFile(sourceFile);
      }
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
        while (connectStatement && connectStatement.getKind() !== SyntaxKind.ExpressionStatement) {
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
      const content = await fs.readFile(testFile, 'utf-8');
      
      // Remove marker comments but keep the code
      const lines = content.split('\n');
      const newLines: string[] = [];
      let inMarkerBlock = false;
      
      for (const line of lines) {
        if (line.includes('// >>>> TESTING-MCP:BEGIN')) {
          inMarkerBlock = true;
          continue; // Skip BEGIN marker
        }
        if (line.includes('// >>>> TESTING-MCP:END')) {
          inMarkerBlock = false;
          continue; // Skip END marker
        }
        
        // Keep all non-marker lines
        newLines.push(line);
      }
      
      await fs.writeFile(testFile, newLines.join('\n'), 'utf-8');
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
    const content = await fs.readFile(testFile, 'utf-8');
    const lines = content.split('\n');
    const generatedBlocks: string[] = [];
    let currentBlock: string[] = [];
    let inMarkerBlock = false;
    
    for (const line of lines) {
      if (line.includes('// >>>> TESTING-MCP:BEGIN')) {
        inMarkerBlock = true;
        currentBlock = [];
        continue;
      }
      if (line.includes('// >>>> TESTING-MCP:END')) {
        inMarkerBlock = false;
        if (currentBlock.length > 0) {
          generatedBlocks.push(currentBlock.join('\n'));
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
    const awaitExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.AwaitExpression);
    
    for (const awaitExpr of awaitExpressions) {
      const callExpr = awaitExpr.getExpression();
      
      if (callExpr.getKind() === SyntaxKind.CallExpression) {
        const callExpression = callExpr.asKindOrThrow(SyntaxKind.CallExpression);
        const expression = callExpression.getExpression();
        
        if (expression.getText() === 'connect') {
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
    const line = sourceFile.getFullText().split('\n')[lineNumber - 1];
    const match = line?.match(/^(\s*)/);
    return match ? match[1] : '';
  }

  /**
   * Indent code with given indentation
   */
  private indentCode(code: string, indent: string): string {
    return code
      .split('\n')
      .map(line => line.trim() ? `${indent}${line}` : line)
      .join('\n');
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

