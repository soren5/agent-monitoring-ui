import { createHash } from 'crypto';
import type Database from 'better-sqlite3';
import type { MonitorPublisher } from './publisher.js';

export interface MessageCommand {
  commandId: string;
  agentGroupId: string;
  body: string;
}
export interface CommandOutcome {
  commandId: string;
  status: 'ack' | 'success' | 'failure';
  code?: string;
  detail?: string;
  retryable?: boolean;
}
export type HostMessageDelivery = (
  agentGroupId: string,
  body: string,
  commandId: string,
) => Promise<{ queued: boolean; wakeRequested?: boolean; detail?: string; retryable?: boolean }>;

type CommandState = 'accepted' | 'delivering' | 'delivered' | 'failed' | 'retryable';
export interface CommandRecord {
  commandId: string;
  hash: string;
  agentGroupId: string;
  body: string;
  state: CommandState;
  outcome: CommandOutcome;
  attempts: number;
}
type ClaimResult = { kind: 'claimed' | 'existing'; record: CommandRecord } | { kind: 'conflict' };
export interface CommandStore {
  claim(command: MessageCommand, hash: string): ClaimResult;
  transition(id: string, from: readonly CommandState[], state: CommandState, outcome: CommandOutcome): boolean;
  recoverable(): CommandRecord[];
}

export class MemoryCommandStore implements CommandStore {
  private readonly records = new Map<string, CommandRecord>();
  claim(command: MessageCommand, hash: string): ClaimResult {
    const old = this.records.get(command.commandId);
    if (old) return old.hash === hash ? { kind: 'existing', record: old } : { kind: 'conflict' };
    const record: CommandRecord = {
      commandId: command.commandId,
      hash,
      agentGroupId: command.agentGroupId,
      body: command.body,
      state: 'accepted',
      outcome: { commandId: command.commandId, status: 'ack' },
      attempts: 0,
    };
    this.records.set(command.commandId, record);
    return { kind: 'claimed', record };
  }
  transition(id: string, from: readonly CommandState[], state: CommandState, outcome: CommandOutcome): boolean {
    const record = this.records.get(id);
    if (!record || !from.includes(record.state)) return false;
    record.state = state;
    record.outcome = outcome;
    if (state === 'delivering') record.attempts++;
    return true;
  }
  recoverable(): CommandRecord[] {
    return [...this.records.values()].filter((record) =>
      ['accepted', 'delivering', 'retryable'].includes(record.state),
    );
  }
}

export class SqliteCommandStore implements CommandStore {
  constructor(private readonly db: Database.Database) {}
  claim(command: MessageCommand, hash: string): ClaimResult {
    return this.db
      .transaction(() => {
        const now = new Date().toISOString();
        const inserted = this.db
          .prepare(
            `INSERT OR IGNORE INTO monitor_command_outcomes
         (command_id,body_hash,outcome_json,created_at,updated_at,agent_group_id,body,state,attempts)
         VALUES(?,?,?,?,?,?,?,?,0)`,
          )
          .run(
            command.commandId,
            hash,
            JSON.stringify({ commandId: command.commandId, status: 'ack' }),
            now,
            now,
            command.agentGroupId,
            command.body,
            'accepted',
          );
        const record = this.get(command.commandId)!;
        if (record.hash !== hash) return { kind: 'conflict' } as ClaimResult;
        return { kind: inserted.changes === 1 ? 'claimed' : 'existing', record } as ClaimResult;
      })
      .immediate();
  }
  transition(id: string, from: readonly CommandState[], state: CommandState, outcome: CommandOutcome): boolean {
    const placeholders = from.map(() => '?').join(',');
    const result = this.db
      .prepare(
        `UPDATE monitor_command_outcomes SET state=?,outcome_json=?,updated_at=?,
       attempts=attempts+CASE WHEN ?='delivering' THEN 1 ELSE 0 END
       WHERE command_id=? AND state IN (${placeholders})`,
      )
      .run(state, JSON.stringify(outcome), new Date().toISOString(), state, id, ...from);
    return result.changes === 1;
  }
  recoverable(): CommandRecord[] {
    return this.rows(`WHERE state IN ('accepted','delivering','retryable')`);
  }
  private get(id: string): CommandRecord | undefined {
    return this.rows('WHERE command_id=?', id)[0];
  }
  private rows(where: string, ...params: unknown[]): CommandRecord[] {
    const rows = this.db
      .prepare(
        `SELECT command_id,body_hash,agent_group_id,body,state,outcome_json,attempts
       FROM monitor_command_outcomes ${where}`,
      )
      .all(...params) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      commandId: String(row.command_id),
      hash: String(row.body_hash),
      agentGroupId: String(row.agent_group_id),
      body: String(row.body),
      state: row.state as CommandState,
      outcome: JSON.parse(String(row.outcome_json)) as CommandOutcome,
      attempts: Number(row.attempts),
    }));
  }
}

export class MessageCommandHandler {
  private recovery: Promise<void> | undefined;
  constructor(
    private store: CommandStore,
    private deliver: HostMessageDelivery,
    private publisher: MonitorPublisher,
  ) {}
  async handle(command: MessageCommand): Promise<CommandOutcome> {
    if (!command.commandId || !command.agentGroupId || !command.body || command.body.length > 12_000)
      return { commandId: command.commandId, status: 'failure', code: 'invalid_command', retryable: false };
    const hash = createHash('sha256').update(`${command.agentGroupId}\0${command.body}`).digest('hex');
    const claim = this.store.claim(command, hash);
    if (claim.kind === 'conflict') return this.failure(command, 'idempotency_conflict', false);
    if (claim.kind === 'existing') return claim.record.outcome;
    this.publisher.publish('command.ack', command.agentGroupId, { accepted: true }, { commandId: command.commandId });
    return this.deliverClaimed(claim.record);
  }
  async recover(): Promise<void> {
    if (this.recovery) return this.recovery;
    this.recovery = (async () => {
      for (const record of this.store.recoverable()) await this.deliverClaimed(record);
    })();
    try {
      await this.recovery;
    } finally {
      this.recovery = undefined;
    }
  }
  private async deliverClaimed(record: CommandRecord): Promise<CommandOutcome> {
    if (!this.store.transition(record.commandId, ['accepted', 'delivering', 'retryable'], 'delivering', record.outcome))
      return record.outcome;
    try {
      const result = await this.deliver(record.agentGroupId, record.body, record.commandId);
      if (result.queued) {
        const outcome: CommandOutcome = {
          commandId: record.commandId,
          status: 'success',
          code: result.wakeRequested === false ? 'queued_wake_failed' : 'queued',
          detail: result.detail,
        };
        this.store.transition(record.commandId, ['delivering'], 'delivered', outcome);
        this.publisher.publish(
          'command.success',
          record.agentGroupId,
          { code: outcome.code, detail: outcome.detail },
          { commandId: record.commandId },
        );
        return outcome;
      }
      const outcome: CommandOutcome = {
        commandId: record.commandId,
        status: 'failure',
        code: 'delivery_failed',
        detail: result.detail,
        retryable: result.retryable ?? true,
      };
      this.store.transition(record.commandId, ['delivering'], outcome.retryable ? 'retryable' : 'failed', outcome);
      this.publisher.publish(
        'command.failure',
        record.agentGroupId,
        { code: outcome.code, detail: outcome.detail, retryable: outcome.retryable },
        { commandId: record.commandId },
      );
      return outcome;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      const outcome: CommandOutcome = {
        commandId: record.commandId,
        status: 'failure',
        code: 'delivery_exception',
        detail: error.message,
        retryable: true,
      };
      this.store.transition(record.commandId, ['delivering'], 'retryable', outcome);
      this.publisher.publish(
        'command.failure',
        record.agentGroupId,
        { code: outcome.code, detail: outcome.detail, retryable: true },
        { commandId: record.commandId },
      );
      return outcome;
    }
  }
  private failure(command: MessageCommand, code: string, retryable: boolean): CommandOutcome {
    const outcome: CommandOutcome = { commandId: command.commandId, status: 'failure', code, retryable };
    this.publisher.publish(
      'command.failure',
      command.agentGroupId,
      { code, retryable },
      { commandId: command.commandId },
    );
    return outcome;
  }
}
