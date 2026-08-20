/** Host-owned declarative profiles for autonomous provisioned children. */
import crypto from 'crypto';

export type AgentTemplate = {
  id: string;
  version: string;
  provider: 'codex' | 'openai-compatible';
  allowedModels: readonly string[];
  capabilityActions: readonly string[];
  maxDescendantDepth: number;
  channelModes: readonly ('singleton' | 'project-report' | 'project-alias')[];
  smokeTestId: string;
  repositoryActions: readonly ('read' | 'branch-write' | 'pr-create' | 'pr-merge')[];
  mergePolicy: 'disabled' | 'parent-review' | 'automated-checks';
  instructionBase: string;
};

const localModels = ['google/gemma-4-12b-qat', 'qwen/qwen3.6-27b'] as const;
const projectActions = [
  'create-child',
  'dispatch-child',
  'activate-child',
  'list-agents',
  'get-status',
  'run-smoke-test',
  'remove-child',
] as const;
const repositoryRead = ['read'] as const;
const repositoryCoding = ['read', 'branch-write', 'pr-create'] as const;

const templates: Record<string, AgentTemplate> = {
  'requirements-parent': {
    id: 'requirements-parent',
    version: '1',
    provider: 'openai-compatible',
    allowedModels: localModels,
    capabilityActions: projectActions,
    maxDescendantDepth: 4,
    channelModes: ['project-report', 'project-alias'],
    smokeTestId: 'basic-agent-message',
    repositoryActions: ['read', 'branch-write', 'pr-create', 'pr-merge'],
    mergePolicy: 'parent-review',
    instructionBase: 'You are a project requirements parent. Create and manage only approved, constrained descendants.',
  },
  api: {
    id: 'api',
    version: '1',
    provider: 'openai-compatible',
    allowedModels: localModels,
    capabilityActions: ['dispatch-child', 'activate-child', 'get-status', 'run-smoke-test'],
    maxDescendantDepth: 2,
    channelModes: ['project-report', 'project-alias'],
    smokeTestId: 'basic-agent-message',
    repositoryActions: repositoryCoding,
    mergePolicy: 'disabled',
    instructionBase: 'You are a constrained API implementation agent. Work only within your assigned project scope.',
  },
  junior: {
    id: 'junior',
    version: '1',
    provider: 'openai-compatible',
    allowedModels: localModels,
    capabilityActions: ['activate-child', 'get-status', 'run-smoke-test'],
    maxDescendantDepth: 1,
    channelModes: ['project-report', 'project-alias'],
    smokeTestId: 'basic-agent-message',
    repositoryActions: repositoryCoding,
    mergePolicy: 'disabled',
    instructionBase: 'You are a constrained junior implementation agent. Report findings to your parent.',
  },
  'local-coding': {
    id: 'local-coding',
    version: '1',
    provider: 'openai-compatible',
    allowedModels: localModels,
    capabilityActions: ['activate-child', 'get-status', 'run-smoke-test'],
    maxDescendantDepth: 1,
    channelModes: ['project-report'],
    smokeTestId: 'basic-agent-message',
    repositoryActions: repositoryCoding,
    mergePolicy: 'disabled',
    instructionBase: 'You are a constrained local coding agent. Work only on bounded tasks from your parent.',
  },
  'local-test': {
    id: 'local-test',
    version: '1',
    provider: 'openai-compatible',
    allowedModels: localModels,
    capabilityActions: ['activate-child', 'get-status', 'run-smoke-test'],
    maxDescendantDepth: 1,
    channelModes: ['project-report'],
    smokeTestId: 'basic-agent-message',
    repositoryActions: repositoryRead,
    mergePolicy: 'disabled',
    instructionBase: 'You are a constrained local testing agent. Return concise test findings to your parent.',
  },
  reviewer: {
    id: 'reviewer',
    version: '1',
    provider: 'openai-compatible',
    allowedModels: localModels,
    capabilityActions: ['activate-child', 'get-status', 'run-smoke-test'],
    maxDescendantDepth: 1,
    channelModes: ['singleton', 'project-report'],
    smokeTestId: 'basic-agent-message',
    repositoryActions: repositoryRead,
    mergePolicy: 'disabled',
    instructionBase: 'You are a constrained reviewer. Report review findings and do not alter runtime configuration.',
  },
  researcher: {
    id: 'researcher',
    version: '1',
    provider: 'openai-compatible',
    allowedModels: localModels,
    capabilityActions: ['activate-child', 'get-status', 'run-smoke-test'],
    maxDescendantDepth: 1,
    channelModes: ['singleton', 'project-report'],
    smokeTestId: 'basic-agent-message',
    repositoryActions: repositoryRead,
    mergePolicy: 'disabled',
    instructionBase: 'You are a constrained researcher. Return findings to your parent.',
  },
  classifier: {
    id: 'classifier',
    version: '1',
    provider: 'openai-compatible',
    allowedModels: localModels,
    capabilityActions: ['activate-child', 'get-status'],
    maxDescendantDepth: 1,
    channelModes: ['project-report'],
    smokeTestId: 'basic-agent-message',
    repositoryActions: repositoryRead,
    mergePolicy: 'disabled',
    instructionBase: 'You are a constrained classification agent. Return structured findings to your parent.',
  },
  formatter: {
    id: 'formatter',
    version: '1',
    provider: 'openai-compatible',
    allowedModels: localModels,
    capabilityActions: ['activate-child', 'get-status'],
    maxDescendantDepth: 1,
    channelModes: ['project-report'],
    smokeTestId: 'basic-agent-message',
    repositoryActions: repositoryRead,
    mergePolicy: 'disabled',
    instructionBase: 'You are a constrained formatting agent. Return the requested formatted result to your parent.',
  },
};

export function getAgentTemplate(id: string): AgentTemplate | undefined {
  return templates[id];
}
export function templateRevision(template: AgentTemplate): string {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(template)).digest('hex')}`;
}
export function templateIds(): string[] {
  return Object.keys(templates);
}
