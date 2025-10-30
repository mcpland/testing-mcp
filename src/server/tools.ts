/**
 * MCP Tools for Testing-MCP
 */

import { z } from 'zod';
import type { MCPToolResponse } from '../types/index.js';
import type { ConnectionManager } from './connectionManager.js';
import type { FileEditor } from './fileEditor.js';

/**
 * Tool input schemas
 */
export const GetCurrentStateSchema = z.object({
  testFile: z.string().optional(),
  testName: z.string().optional()
});

export const FinalizeTestSchema = z.object({
  testFile: z.string(),
  removeMarkers: z.boolean().optional().default(true)
});

export const ExecuteTestStepSchema = z.object({
  code: z.string(),
  testFile: z.string().optional(),
  testName: z.string().optional()
});

/**
 * MCP Tools Implementation
 */
export class MCPTools {
  constructor(
    private connectionManager: ConnectionManager,
    private fileEditor: FileEditor
  ) {}

  /**
   * Tool: get_current_test_state
   * Get the current state of a connected test
   */
  async getCurrentTestState(params: z.infer<typeof GetCurrentStateSchema>): Promise<MCPToolResponse> {
    try {
      const state = this.connectionManager.getCurrentState(
        params.testFile,
        params.testName
      );

      if (!state) {
        return {
          success: false,
          error: 'No active test connection found. Please ensure a test is running with await connect().'
        };
      }

      return {
        success: true,
        message: 'Retrieved current test state',
        newState: state
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Tool: finalize_test
   * Remove connect() and clean up markers
   */
  async finalizeTest(params: z.infer<typeof FinalizeTestSchema>): Promise<MCPToolResponse> {
    try {
      const { testFile, removeMarkers } = params;

      // Get the connection info before removing
      const connections = this.connectionManager.getActiveConnections();
      const connection = connections.find(conn => conn.testFile === testFile);

      // Remove connect() call
      await this.fileEditor.removeConnect(testFile);

      // Optionally remove markers
      if (removeMarkers) {
        await this.fileEditor.removeMarkers(testFile);
      }

      // Send close signal to test process to release the await connect()
      if (connection) {
        this.connectionManager.sendClose(connection.testFile, connection.testName);
      }

      return {
        success: true,
        message: `Test finalized: ${testFile}. The test is now ready to run normally.`
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Tool: list_active_tests
   * List all currently connected tests
   */
  async listActiveTests(): Promise<MCPToolResponse> {
    try {
      const connections = this.connectionManager.getActiveConnections();

      if (connections.length === 0) {
        return {
          success: true,
          message: 'No active test connections',
          newState: undefined
        };
      }

      const testList = connections.map(conn => ({
        testFile: conn.testFile,
        testName: conn.testName,
        sessionId: conn.sessionId,
        connectedAt: new Date(conn.connectedAt).toISOString()
      }));

      return {
        success: true,
        message: `Found ${connections.length} active test(s)`,
        newState: { tests: testList } as any
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Tool: get_generated_code
   * Get all generated code from a test file
   */
  async getGeneratedCode(testFile: string): Promise<MCPToolResponse> {
    try {
      const generatedBlocks = await this.fileEditor.getGeneratedCode(testFile);

      if (generatedBlocks.length === 0) {
        return {
          success: true,
          message: 'No generated code found',
          code: ''
        };
      }

      return {
        success: true,
        message: `Found ${generatedBlocks.length} generated code block(s)`,
        code: generatedBlocks.join('\n\n')
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Tool: execute_test_step
   * Execute code directly in the client and get back DOM and logs
   */
  async executeTestStep(params: z.infer<typeof ExecuteTestStepSchema>): Promise<MCPToolResponse> {
    try {
      // Get current state to find which test to execute in
      const currentState = this.connectionManager.getCurrentState(
        params.testFile,
        params.testName
      );

      if (!currentState) {
        return {
          success: false,
          error: 'No active test connection. Ensure test is running with await connect().'
        };
      }

      const { testFile, testName } = currentState;

      console.error(`[testing-mcp] Executing code in test: ${testFile} - ${testName}`);
      console.error(`[testing-mcp] Code to execute:\n${params.code}`);

      // Send execute command to client and wait for response
      const newState = await this.connectionManager.sendExecute(
        testFile,
        testName,
        params.code,
        30000 // 30 second timeout
      );

      return {
        success: true,
        message: `Code executed successfully. DOM updated.`,
        code: params.code,
        newState: newState
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }
}
