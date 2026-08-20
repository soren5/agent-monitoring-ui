import { notifyAgent } from '../approvals/index.js';
import {
  createFeatureBranch,
  mergePullRequest,
  createPullRequest,
  getRepositoryMetadata,
  writeRepositoryFile,
} from '../../github-app-broker.js';
import type { Session } from '../../types.js';

function audit(
  session: Session,
  repository: string,
  operation: string,
  outcome: 'allowed' | 'denied',
  request: unknown,
): void {
  getDb()
    .prepare(
      `INSERT INTO repository_audit_events
       (created_at, caller_group_id, repository_id, operation, outcome, request_hash)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      new Date().toISOString(),
      session.agent_group_id,
      repository,
      operation,
      outcome,
      crypto.createHash('sha256').update(JSON.stringify(request)).digest('hex'),
    );
}
export async function handleRepositoryAction(content: Record<string, unknown>, session: Session): Promise<void> {
  const op = String(content.action ?? '');
  const repository = String(content.repository ?? '');
  try {
    let result: unknown;
    if (op === 'repository.get_metadata') result = await getRepositoryMetadata(session.agent_group_id, repository);
    else if (op === 'repository.create_branch')
      result = await createFeatureBranch(
        session.agent_group_id,
        repository,
        String(content.branch),
        typeof content.base === 'string' ? content.base : 'main',
      );
    else if (op === 'repository.write_file') {
      await writeRepositoryFile(
        session.agent_group_id,
        repository,
        String(content.branch),
        String(content.path),
        String(content.content),
        String(content.message),
      );
      result = { ok: true };
    } else if (op === 'repository.create_pr')
      result = await createPullRequest(
        session.agent_group_id,
        repository,
        String(content.head),
        String(content.title),
        String(content.body),
        typeof content.base === 'string' ? content.base : 'main',
      );
    else if (op === 'repository.merge_pr')
      result = await mergePullRequest(session.agent_group_id, repository, Number(content.pull_number));
    else throw new Error('Unknown repository operation.');
    audit(session, repository, op, 'allowed', content);
    notifyAgent(session, `Repository result: ${JSON.stringify({ ok: true, operation: op, result })}`);
  } catch (error) {
    audit(session, repository, op, 'denied', content);
    notifyAgent(
      session,
      `Repository result: ${JSON.stringify({ ok: false, operation: op, error: error instanceof Error ? error.message : String(error) })}`,
    );
  }
}
import crypto from 'crypto';

import { getDb } from '../../db/connection.js';
