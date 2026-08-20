/** Requests only: the host authenticates the session and enforces repository grants. */
import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';
const emit = (action: string, args: Record<string, unknown>) => { const id = `repo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; writeMessageOut({ id, kind: 'system', content: JSON.stringify({ action, requestId: id, ...args }) }); return { content: [{ type: 'text' as const, text: `Repository request submitted (${id}).` }] }; };
const str = { type: 'string' as const };
registerTools([
  { tool: { name: 'repository_get_metadata', description: 'Read granted repository metadata.', inputSchema: { type: 'object', properties: { repository: str }, required: ['repository'] } }, handler: a => emit('repository.get_metadata', a) },
  { tool: { name: 'repository_create_branch', description: 'Create a granted feature branch.', inputSchema: { type: 'object', properties: { repository: str, branch: str, base: str }, required: ['repository','branch'] } }, handler: a => emit('repository.create_branch', a) },
  { tool: { name: 'repository_write_file', description: 'Write one file to a granted branch.', inputSchema: { type: 'object', properties: { repository: str, branch: str, path: str, content: str, message: str }, required: ['repository','branch','path','content','message'] } }, handler: a => emit('repository.write_file', a) },
  { tool: { name: 'repository_create_pr', description: 'Open a PR from a granted branch.', inputSchema: { type: 'object', properties: { repository: str, head: str, title: str, body: str, base: str }, required: ['repository','head','title','body'] } }, handler: a => emit('repository.create_pr', a) },
  { tool: { name: 'repository_merge_pr', description: 'Merge an approved PR from a granted descendant branch.', inputSchema: { type: 'object', properties: { repository: str, pull_number: { type: 'number' as const } }, required: ['repository','pull_number'] } }, handler: a => emit('repository.merge_pr', a) },
] as McpToolDefinition[]);
