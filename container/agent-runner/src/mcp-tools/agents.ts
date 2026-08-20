/**
 * Legacy agent-management surface.
 *
 * send_to_agent was removed — sending to another agent is now just
 * send_message(to="agent-name") since agents and channels share the
 * unified destinations namespace.
 *
 * `create_agent` is intentionally no longer registered. All descendants use
 * the Factory provisioning contract, which freezes a host-derived template
 * and requires owner approval before a group exists. The host also rejects a
 * forged legacy system action.
 */
import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

export const createAgent: McpToolDefinition = {
  tool: {
    name: 'create_agent',
    description:
      'Create a long-lived companion sub-agent (research assistant, task manager, specialist) — the name becomes your destination for it. May require admin approval before the agent is created. Fire-and-forget.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Human-readable name (also becomes your destination name for this agent)' },
        instructions: { type: 'string', description: 'CLAUDE.md content for the new agent (personality, role, instructions)' },
        provider: { type: 'string', enum: ['openai-compatible'], description: 'Optional owner-approved local model provider' },
        model: {
          type: 'string',
          enum: ['google/gemma-4-12b-qat', 'qwen/qwen3.6-27b'],
          description: 'Approved LM Studio model; required when provider is openai-compatible',
        },
      },
      required: ['name'],
    },
  },
  async handler(args) {
    const name = args.name as string;
    if (!name) return err('name is required');

    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'create_agent',
        requestId,
        name,
        instructions: (args.instructions as string) || null,
        provider: (args.provider as string) || null,
        model: (args.model as string) || null,
      }),
    });

    log(`create_agent: ${requestId} → "${name}"`);
    return ok(`Creating agent "${name}". You will be notified when it is ready.`);
  },
};

registerTools([]);
