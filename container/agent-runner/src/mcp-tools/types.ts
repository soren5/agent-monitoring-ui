import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export interface McpToolDefinition {
  tool: Tool;
  // Request-only tools complete synchronously after writing their host-bound
  // message; provider-backed tools may await work. The server awaits either.
  handler: (args: Record<string, unknown>) => CallToolResult | Promise<CallToolResult>;
}
