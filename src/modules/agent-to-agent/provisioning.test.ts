import crypto from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  approvalHandlers,
  notifications,
  requestApproval,
  initGroupFilesystem,
  writeDestinations,
  wakeContainer,
  probeLocalModel,
  writeSessionMessage,
} = vi.hoisted(() => ({
  approvalHandlers: new Map<string, (context: Record<string, any>) => Promise<void>>(),
  notifications: vi.fn(),
  requestApproval: vi.fn().mockResolvedValue(undefined),
  initGroupFilesystem: vi.fn(),
  writeDestinations: vi.fn(),
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  probeLocalModel: vi.fn().mockResolvedValue({ ok: true }),
  writeSessionMessage: vi.fn(),
}));

vi.mock('../approvals/index.js', () => ({
  notifyAgent: (...args: unknown[]) => notifications(...args),
  requestApproval: (...args: unknown[]) => requestApproval(...args),
  registerApprovalHandler: (action: string, handler: (context: Record<string, any>) => Promise<void>) =>
    approvalHandlers.set(action, handler),
  registerApprovalResolvedHandler: vi.fn(),
}));
vi.mock('../../group-init.js', () => ({ initGroupFilesystem: (...args: unknown[]) => initGroupFilesystem(...args) }));
vi.mock('../../container-runner.js', () => ({ wakeContainer: (...args: unknown[]) => wakeContainer(...args) }));
vi.mock('../../session-manager.js', () => ({
  resolveSession: (agentGroupId: string) => ({
    session: { id: `system-${agentGroupId}`, agent_group_id: agentGroupId },
    created: true,
  }),
  writeSessionMessage: (...args: unknown[]) => writeSessionMessage(...args),
}));
vi.mock('../../db/sessions.js', () => ({
  deletePendingApproval: vi.fn(),
  getPendingApprovalsByAction: () => [],
  getSession: () => undefined,
  getSessionsByAgentGroup: () => [],
  findSessionByAgentGroup: (agentGroupId: string) => ({ id: `system-${agentGroupId}`, agent_group_id: agentGroupId }),
}));
vi.mock('./local-model-health.js', () => ({ probeLocalModel: (...args: unknown[]) => probeLocalModel(...args) }));
vi.mock('./write-destinations.js', () => ({ writeDestinations: (...args: unknown[]) => writeDestinations(...args) }));

import { closeDb, createAgentGroup, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import type { AgentGroup, Session } from '../../types.js';
import { getLiveRelation } from './relations.js';
import {
  getProvisionedStatus,
  getProvisionedAgentSummary,
  dispatchProvisionedChild,
  listProvisionedChildren,
  removeProvisionedChild,
  requestAgentProvision,
  runProvisionedSmokeTest,
  observeProvisionedSmokeResponse,
  sweepProvisionedSmokeTests,
  wakeProvisionedChild,
} from './provisioning.js';

const ROOT = 'ag-root';
const session = { id: 'sess-root', agent_group_id: ROOT } as Session;
const group = (id: string): AgentGroup => ({
  id,
  name: id,
  folder: id,
  agent_provider: null,
  created_at: new Date().toISOString(),
});
const approval = () => approvalHandlers.get('agent_provision')!;

describe('owner-approved autonomous provisioning', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runMigrations(initTestDb());
    createAgentGroup(group(ROOT));
  });
  afterEach(closeDb);

  it('holds a bounded request, then atomically materializes its relation, destinations, and exact grants', async () => {
    await requestAgentProvision(
      { template_id: 'local-test', display_name: 'API Tests', requested_actions: ['activate-child', 'dispatch-child'] },
      session,
    );
    const request = getDb().prepare('SELECT * FROM agent_provision_requests').get() as Record<string, string>;
    expect(request).toMatchObject({ parent_agent_group_id: ROOT, state: 'pending', template_id: 'local-test' });
    expect(requestApproval).toHaveBeenCalledOnce();

    await approval()({
      session,
      payload: { request_id: request.request_id },
      approval: { approval_id: 'owner-approval' },
    });
    const materialized = getDb()
      .prepare('SELECT * FROM agent_provision_requests WHERE request_id=?')
      .get(request.request_id) as Record<string, string>;
    const childId = materialized.provisioned_child_group_id;
    expect(materialized).toMatchObject({
      state: 'provisioned',
      owner_approval_id: 'owner-approval',
      projection_state: 'ready',
    });
    expect(getLiveRelation(childId)).toMatchObject({
      parent_agent_group_id: ROOT,
      created_by_provision_request_id: request.request_id,
    });
    expect(
      getDb().prepare('SELECT COUNT(*) AS n FROM agent_destinations WHERE agent_group_id IN (?, ?)').get(ROOT, childId),
    ).toMatchObject({ n: 2 });
    expect(
      getDb()
        .prepare(
          'SELECT COUNT(*) AS n FROM capability_grants WHERE subject_agent_group_id=? AND resource_id=? AND revoked_at IS NULL',
        )
        .get(ROOT, childId),
    ).toMatchObject({ n: 2 });

    // Approval replay returns the original child rather than creating another.
    await approval()({
      session,
      payload: { request_id: request.request_id },
      approval: { approval_id: 'owner-approval' },
    });
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM agent_groups').get()).toMatchObject({ n: 2 });
  });

  it('bootstraps a requirements project and its sole ordinary channel responder in one approved transaction', async () => {
    await requestAgentProvision(
      {
        template_id: 'requirements-parent',
        display_name: 'Requirements',
        repository_id: 'soren5/agent-monitoring-ui',
        requested_actions: [
          'create-child',
          'activate-child',
          'dispatch-child',
          'list-agents',
          'get-status',
          'run-smoke-test',
          'remove-child',
        ],
        project_bootstrap: { project_id: 'agent-monitoring-ui', platform_id: 'discord:123456:888888' },
      },
      session,
    );
    const request = getDb().prepare('SELECT * FROM agent_provision_requests').get() as Record<string, string>;
    expect(request).toMatchObject({
      state: 'pending',
      project_bootstrap_id: 'agent-monitoring-ui',
      channel_mode: 'project-parent',
    });

    await approval()({
      session,
      payload: { request_id: request.request_id },
      approval: { approval_id: 'owner-approval' },
    });
    const childId = (
      getDb().prepare('SELECT * FROM agent_provision_requests WHERE request_id=?').get(request.request_id) as Record<
        string,
        string
      >
    ).provisioned_child_group_id;
    expect(getDb().prepare('SELECT * FROM projects WHERE project_id=?').get('agent-monitoring-ui')).toMatchObject({
      project_parent_group_id: childId,
      platform_id: 'discord:123456:888888',
    });
    expect(getLiveRelation(childId)).toMatchObject({ project_id: 'agent-monitoring-ui' });
    expect(
      getDb()
        .prepare(
          "SELECT COUNT(*) AS n FROM capability_grants WHERE subject_agent_group_id=? AND resource_id=? AND actions_json LIKE '%create-child%' AND revoked_at IS NULL",
        )
        .get(ROOT, childId),
    ).toMatchObject({ n: 1 });
    expect(
      getDb().prepare('SELECT COUNT(*) AS n FROM messaging_group_agents WHERE agent_group_id=?').get(childId),
    ).toMatchObject({ n: 1 });
    await expect(removeProvisionedChild(session, childId)).resolves.toMatchObject({ ok: true });
    // Revoking a Requirements parent must not delete the shared project
    // channel record. It may later be closed/reassigned only through a
    // dedicated project lifecycle operation.
    expect(
      getDb()
        .prepare(
          'SELECT COUNT(*) AS n FROM messaging_groups WHERE id=(SELECT messaging_group_id FROM projects WHERE project_id=?)',
        )
        .get('agent-monitoring-ui'),
    ).toMatchObject({ n: 1 });
  });

  it('rejects a requirements parent unless it atomically bootstraps a project channel', async () => {
    await requestAgentProvision({ template_id: 'requirements-parent', display_name: 'Requirements' }, session);
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM agent_provision_requests').get()).toMatchObject({ n: 0 });
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('reports the exact rejected provisioning field without persisting a request', async () => {
    await requestAgentProvision(
      {
        template_id: 'requirements-parent',
        display_name: 'Requirements',
        requested_actions: ['not-an-action'],
        project_bootstrap: { project_id: 'agent-monitoring-ui', platform_id: 'discord:123456:888888' },
      },
      session,
    );
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM agent_provision_requests').get()).toMatchObject({ n: 0 });
    expect(notifications).toHaveBeenLastCalledWith(
      session,
      expect.stringContaining('requested_actions contains an unsupported action.'),
    );
  });

  it('does not create a usable child when materialization fails', async () => {
    await requestAgentProvision(
      { template_id: 'local-test', display_name: 'Broken', requested_actions: ['activate-child'] },
      session,
    );
    const request = getDb().prepare('SELECT * FROM agent_provision_requests').get() as Record<string, string>;
    initGroupFilesystem.mockImplementationOnce(() => {
      throw new Error('simulated filesystem failure');
    });

    await approval()({
      session,
      payload: { request_id: request.request_id },
      approval: { approval_id: 'owner-approval' },
    });
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM agent_groups').get()).toMatchObject({ n: 1 });
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM agent_relations').get()).toMatchObject({ n: 0 });
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM capability_grants').get()).toMatchObject({ n: 0 });
    expect(
      getDb()
        .prepare('SELECT state, failure_category FROM agent_provision_requests WHERE request_id=?')
        .get(request.request_id),
    ).toMatchObject({ state: 'failed', failure_category: 'materialization_failed' });
  });

  it('fails closed before materializing a local-model child when host health is unavailable', async () => {
    await requestAgentProvision(
      { template_id: 'local-test', display_name: 'Unavailable local backend', requested_actions: ['activate-child'] },
      session,
    );
    const request = getDb().prepare('SELECT * FROM agent_provision_requests').get() as Record<string, string>;
    probeLocalModel.mockResolvedValueOnce({ ok: false, category: 'endpoint' });

    await approval()({
      session,
      payload: { request_id: request.request_id },
      approval: { approval_id: 'owner-approval' },
    });

    expect(getDb().prepare('SELECT COUNT(*) AS n FROM agent_groups').get()).toMatchObject({ n: 1 });
    expect(initGroupFilesystem).not.toHaveBeenCalled();
    expect(
      getDb()
        .prepare('SELECT state, failure_category FROM agent_provision_requests WHERE request_id=?')
        .get(request.request_id),
    ).toMatchObject({ state: 'failed', failure_category: 'materialization_failed' });
  });

  it('materializes an owner-approved singleton as its own strict Discord responder', async () => {
    await requestAgentProvision(
      {
        template_id: 'reviewer',
        display_name: 'Review singleton',
        requested_actions: ['get-status', 'remove-child'],
        channel_binding: { channel_type: 'discord', platform_id: 'discord:123456:654321', mode: 'singleton' },
      },
      session,
    );
    const request = getDb().prepare('SELECT * FROM agent_provision_requests').get() as Record<string, string>;
    await approval()({ session, payload: { request_id: request.request_id }, approval: { approval_id: 'owner' } });
    const childId = (
      getDb()
        .prepare('SELECT provisioned_child_group_id FROM agent_provision_requests WHERE request_id=?')
        .get(request.request_id) as {
        provisioned_child_group_id: string;
      }
    ).provisioned_child_group_id;
    expect(
      getDb().prepare('SELECT COUNT(*) AS n FROM messaging_groups WHERE platform_id=?').get('discord:123456:654321'),
    ).toMatchObject({ n: 1 });
    expect(
      getDb().prepare('SELECT COUNT(*) AS n FROM messaging_group_agents WHERE agent_group_id=?').get(childId),
    ).toMatchObject({ n: 1 });
    await expect(removeProvisionedChild(session, childId)).resolves.toMatchObject({ ok: true });
    expect(
      getDb().prepare('SELECT COUNT(*) AS n FROM messaging_groups WHERE platform_id=?').get('discord:123456:654321'),
    ).toMatchObject({ n: 0 });
  });

  it('adds a project child as a report-only project member without creating another responder', async () => {
    createMessagingGroup({
      id: 'mg-project',
      channel_type: 'discord',
      platform_id: 'discord:123456:777777',
      instance: 'discord',
      name: 'project',
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: new Date().toISOString(),
    });
    getDb()
      .prepare(
        `INSERT INTO projects (project_id, project_parent_group_id, channel_type, platform_id, messaging_group_id, created_at)
         VALUES ('project-one', ?, 'discord', 'discord:123456:777777', 'mg-project', ?)`,
      )
      .run(ROOT, new Date().toISOString());
    await requestAgentProvision(
      {
        template_id: 'local-test',
        display_name: 'Project tests',
        requested_actions: ['get-status'],
        project_id: 'project-one',
        channel_binding: { channel_type: 'discord', platform_id: 'discord:123456:777777', mode: 'project-report' },
      },
      session,
    );
    const request = getDb().prepare('SELECT * FROM agent_provision_requests').get() as Record<string, string>;
    await approval()({ session, payload: { request_id: request.request_id }, approval: { approval_id: 'owner' } });
    const childId = (
      getDb()
        .prepare('SELECT provisioned_child_group_id FROM agent_provision_requests WHERE request_id=?')
        .get(request.request_id) as {
        provisioned_child_group_id: string;
      }
    ).provisioned_child_group_id;
    expect(
      getDb().prepare('SELECT project_id, agent_group_id FROM project_agents WHERE agent_group_id=?').get(childId),
    ).toMatchObject({ project_id: 'project-one', agent_group_id: childId });
    expect(
      getDb()
        .prepare("SELECT COUNT(*) AS n FROM agent_destinations WHERE agent_group_id=? AND local_name='project'")
        .get(childId),
    ).toMatchObject({ n: 1 });
    expect(
      getDb().prepare('SELECT COUNT(*) AS n FROM messaging_group_agents WHERE messaging_group_id=?').get('mg-project'),
    ).toMatchObject({ n: 0 });
  });

  it('denies a provisioned descendant that tries to exceed its frozen template ceiling', async () => {
    createAgentGroup(group('ag-api'));
    getDb()
      .prepare(
        "INSERT INTO agent_relations (child_agent_group_id, parent_agent_group_id, root_agent_group_id, project_id, depth, created_by_provision_request_id, created_at) VALUES ('ag-api', ?, ?, NULL, 1, NULL, ?)",
      )
      .run(ROOT, ROOT, new Date().toISOString());
    getDb()
      .prepare(
        "INSERT INTO agent_provision_requests (request_id, parent_agent_group_id, project_id, template_id, template_revision, display_name, normalized_name, requested_actions_json, instruction_overlay, repository_id, channel_type, platform_id, channel_mode, state, provisioned_child_group_id, created_at) VALUES ('parent-contract', ?, NULL, 'api', 'test', 'API', 'api', '[]', '', NULL, NULL, NULL, NULL, 'provisioned', 'ag-api', ?)",
      )
      .run(ROOT, new Date().toISOString());
    await requestAgentProvision(
      { template_id: 'local-test', display_name: 'Too Broad', requested_actions: ['list-agents'] },
      { ...session, agent_group_id: 'ag-api' },
    );
    expect(requestApproval).not.toHaveBeenCalled();
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM agent_provision_requests').get()).toMatchObject({ n: 1 });
  });

  it('lists and removes only a direct child whose derived grants permit it', async () => {
    await requestAgentProvision(
      {
        template_id: 'local-test',
        display_name: 'Disposable',
        requested_actions: ['list-agents', 'remove-child'],
      },
      session,
    );
    const request = getDb().prepare('SELECT * FROM agent_provision_requests').get() as Record<string, string>;
    await approval()({ session, payload: { request_id: request.request_id }, approval: { approval_id: 'owner' } });
    const childId = (
      getDb()
        .prepare('SELECT provisioned_child_group_id FROM agent_provision_requests WHERE request_id=?')
        .get(request.request_id) as {
        provisioned_child_group_id: string;
      }
    ).provisioned_child_group_id;
    expect(listProvisionedChildren(session)).toMatchObject({
      ok: true,
      children: [expect.objectContaining({ agent_group_id: childId })],
    });
    expect(await removeProvisionedChild(session, childId)).toMatchObject({
      ok: true,
      removed_agent_group_ids: [childId],
    });
    expect(getLiveRelation(childId)).toBeUndefined();
    expect(await dispatchProvisionedChild(session, childId, 'must not run')).toMatchObject({ ok: false });
  });

  it('returns a redacted generic Factory summary only for a visible direct child', async () => {
    await requestAgentProvision(
      { template_id: 'local-test', display_name: 'Inspectable', requested_actions: ['get-status', 'list-agents'] },
      session,
    );
    const request = getDb().prepare('SELECT * FROM agent_provision_requests').get() as Record<string, string>;
    await approval()({ session, payload: { request_id: request.request_id }, approval: { approval_id: 'owner' } });
    const childId = (
      getDb().prepare('SELECT provisioned_child_group_id FROM agent_provision_requests').get() as Record<string, string>
    ).provisioned_child_group_id;
    expect(await getProvisionedAgentSummary(session, childId)).toMatchObject({
      ok: true,
      agent_group_id: childId,
      template_id: 'local-test',
      parent_agent_group_id: ROOT,
      routing: { destination_types: ['agent'] },
    });
    expect(await getProvisionedAgentSummary({ ...session, agent_group_id: 'ag-outsider' }, childId)).toMatchObject({
      ok: false,
    });
  });

  it('exposes only redacted status and runs a fixed smoke fixture for an authorized parent', async () => {
    await requestAgentProvision(
      {
        template_id: 'local-test',
        display_name: 'Observable',
        requested_actions: ['activate-child', 'get-status', 'run-smoke-test'],
      },
      session,
    );
    const request = getDb().prepare('SELECT * FROM agent_provision_requests').get() as Record<string, string>;
    await approval()({
      session,
      payload: { request_id: request.request_id },
      approval: { approval_id: 'owner-approval' },
    });
    const childId = (
      getDb()
        .prepare('SELECT provisioned_child_group_id FROM agent_provision_requests WHERE request_id=?')
        .get(request.request_id) as Record<string, string>
    ).provisioned_child_group_id;
    getDb()
      .prepare(
        "INSERT INTO container_configs (agent_group_id, provider, model, cli_scope, updated_at) VALUES (?, 'openai-compatible', 'google/gemma-4-12b-qat', 'disabled', ?)",
      )
      .run(childId, new Date().toISOString());

    expect(await getProvisionedStatus(session, childId)).toMatchObject({
      ok: true,
      template_id: 'local-test',
      provider: 'openai-compatible',
    });
    expect(await getProvisionedStatus({ ...session, agent_group_id: 'ag-outsider' }, childId)).toMatchObject({
      ok: false,
    });
    probeLocalModel.mockResolvedValueOnce({ ok: false, category: 'completion' });
    expect(await getProvisionedStatus(session, childId)).toMatchObject({
      ok: true,
      status: 'backend_unhealthy',
      backend_health: 'completion',
    });
    expect(await wakeProvisionedChild(session, childId)).toMatchObject({ ok: true });
    expect(wakeContainer).toHaveBeenCalled();
    expect(await runProvisionedSmokeTest(session, childId)).toMatchObject({ ok: true, state: 'running' });
    expect(
      getDb().prepare('SELECT fixture_id, state FROM agent_smoke_test_results WHERE agent_group_id=?').get(childId),
    ).toMatchObject({ fixture_id: 'basic-agent-message', state: 'running' });

    const dispatched = writeSessionMessage.mock.calls.find(([id]) => id === childId)?.[2] as { content: string };
    const expected = /SMOKE_OK [A-Za-z0-9_-]+/.exec(dispatched.content)?.[0];
    expect(expected).toBeTruthy();
    expect(observeProvisionedSmokeResponse(childId, ROOT, JSON.stringify({ text: expected }))).toBe(true);
    expect(
      getDb()
        .prepare('SELECT state, output_redacted FROM agent_smoke_test_results WHERE agent_group_id=?')
        .get(childId),
    ).toMatchObject({
      state: 'passed',
      output_redacted: 'SMOKE_OK',
    });
  });

  it('fails invalid smoke output and expires a non-responsive run without trusting either response', async () => {
    await requestAgentProvision(
      { template_id: 'local-test', display_name: 'Smoke Timeout', requested_actions: ['run-smoke-test'] },
      session,
    );
    const request = getDb().prepare('SELECT * FROM agent_provision_requests').get() as Record<string, string>;
    await approval()({ session, payload: { request_id: request.request_id }, approval: { approval_id: 'owner' } });
    const childId = (
      getDb().prepare('SELECT provisioned_child_group_id FROM agent_provision_requests').get() as Record<string, string>
    ).provisioned_child_group_id;
    await runProvisionedSmokeTest(session, childId);
    expect(observeProvisionedSmokeResponse(childId, ROOT, JSON.stringify({ text: 'SMOKE_OK forged' }))).toBe(true);
    expect(
      getDb().prepare('SELECT state FROM agent_smoke_test_results WHERE agent_group_id=?').get(childId),
    ).toMatchObject({ state: 'failed' });

    const stale = 'smoke-stale';
    getDb()
      .prepare(
        "INSERT INTO agent_smoke_test_results (smoke_test_id, agent_group_id, fixture_id, state, expected_response_hash, started_at) VALUES (?, ?, 'basic-agent-message', 'running', ?, ?)",
      )
      .run(stale, childId, crypto.createHash('sha256').update('unused').digest('hex'), '2026-01-01T00:00:00.000Z');
    expect(sweepProvisionedSmokeTests('2026-01-01T00:03:00.000Z')).toBe(1);
    expect(
      getDb().prepare('SELECT state, output_redacted FROM agent_smoke_test_results WHERE smoke_test_id=?').get(stale),
    ).toMatchObject({
      state: 'timeout',
      output_redacted: 'timeout',
    });
  });

  it('materializes a template-bounded, credential-free repository broker profile', async () => {
    await requestAgentProvision(
      { template_id: 'local-coding', display_name: 'Code Writer', repository_id: 'soren5/agent-monitoring-ui' },
      session,
    );
    const request = getDb().prepare('SELECT * FROM agent_provision_requests').get() as Record<string, string>;
    await approval()({
      session,
      payload: { request_id: request.request_id },
      approval: { approval_id: 'owner-approval' },
    });
    const childId = (
      getDb()
        .prepare('SELECT provisioned_child_group_id FROM agent_provision_requests WHERE request_id=?')
        .get(request.request_id) as Record<string, string>
    ).provisioned_child_group_id;
    expect(
      getDb()
        .prepare('SELECT repository_id, merge_policy FROM agent_repository_profiles WHERE agent_group_id=?')
        .get(childId),
    ).toMatchObject({ repository_id: 'soren5/agent-monitoring-ui', merge_policy: 'disabled' });
    expect(
      getDb()
        .prepare(
          "SELECT COUNT(*) AS n FROM capability_grants WHERE subject_agent_group_id=? AND resource_type='repository'",
        )
        .get(childId),
    ).toMatchObject({ n: 3 });
  });
});
