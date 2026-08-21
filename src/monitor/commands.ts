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
}
export type HostMessageDelivery = (
  agentGroupId: string,
  body: string,
) => Promise<{ delivered: boolean; detail?: string }>;
export interface CommandStore {
  get(id: string): { hash: string; outcome: CommandOutcome } | undefined;
  set(id: string, value: { hash: string; outcome: CommandOutcome }): void;
}
export class MemoryCommandStore implements CommandStore {
  private m = new Map<string, { hash: string; outcome: CommandOutcome }>();
  get(id: string) {
    return this.m.get(id);
  }
  set(id: string, v: { hash: string; outcome: CommandOutcome }) {
    this.m.set(id, v);
  }
}

export class SqliteCommandStore implements CommandStore {
  constructor(private readonly db: Database.Database) {}
  get(id: string): { hash: string; outcome: CommandOutcome } | undefined {
    const row = this.db
      .prepare('SELECT body_hash, outcome_json FROM monitor_command_outcomes WHERE command_id = ?')
      .get(id) as { body_hash: string; outcome_json: string } | undefined;
    return row ? { hash: row.body_hash, outcome: JSON.parse(row.outcome_json) as CommandOutcome } : undefined;
  }
  set(id: string, value: { hash: string; outcome: CommandOutcome }): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO monitor_command_outcomes(command_id,body_hash,outcome_json,created_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(command_id) DO UPDATE SET body_hash=excluded.body_hash,outcome_json=excluded.outcome_json,updated_at=excluded.updated_at`,
      )
      .run(id, value.hash, JSON.stringify(value.outcome), now, now);
  }
}

export class MessageCommandHandler {
  constructor(
    private store: CommandStore,
    private deliver: HostMessageDelivery,
    private publisher: MonitorPublisher,
  ) {}
  async handle(c: MessageCommand): Promise<CommandOutcome> {
    if (!c.commandId || !c.agentGroupId || !c.body || c.body.length > 12_000)
      return { commandId: c.commandId, status: 'failure', code: 'invalid_command' };
    const hash = createHash('sha256').update(`${c.agentGroupId}\0${c.body}`).digest('hex');
    const prior = this.store.get(c.commandId);
    if (prior) {
      if (prior.hash !== hash) {
        const conflict: CommandOutcome = { commandId: c.commandId, status: 'failure', code: 'idempotency_conflict' };
        this.publisher.publish('command.failure', c.agentGroupId, { code: conflict.code }, { commandId: c.commandId });
        return conflict;
      }
      return prior.outcome;
    }
    // Persist acceptance before delivery: ack does not claim delivery.
    const ack: CommandOutcome = { commandId: c.commandId, status: 'ack' };
    this.store.set(c.commandId, { hash, outcome: ack });
    this.publisher.publish('command.ack', c.agentGroupId, { accepted: true }, { commandId: c.commandId });
    try {
      const result = await this.deliver(c.agentGroupId, c.body);
      const outcome: CommandOutcome = result.delivered
        ? { commandId: c.commandId, status: 'success', detail: result.detail }
        : { commandId: c.commandId, status: 'failure', code: 'delivery_failed', detail: result.detail };
      this.store.set(c.commandId, { hash, outcome });
      this.publisher.publish(
        result.delivered ? 'command.success' : 'command.failure',
        c.agentGroupId,
        { detail: result.detail },
        { commandId: c.commandId },
      );
      return outcome;
    } catch (e) {
      if (!(e instanceof Error)) throw e;
      const outcome: CommandOutcome = {
        commandId: c.commandId,
        status: 'failure',
        code: 'delivery_failed',
        detail: e.message,
      };
      this.store.set(c.commandId, { hash, outcome });
      this.publisher.publish('command.failure', c.agentGroupId, { detail: outcome.detail }, { commandId: c.commandId });
      return outcome;
    }
  }
}
