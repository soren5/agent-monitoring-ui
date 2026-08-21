import { describe, expect, it, vi } from 'vitest';
import { ClientProjection, MonitorPublisher, ProgressCoalescer } from './publisher.js';
import { deterministicAgents } from './fixtures.js';
const agent = { status: 'idle', hasBlockers: false, reasoningAvailability: 'none' };
describe('publisher', () => {
  it('deduplicates IDs and orders ten concurrent updates', async () => {
    const p = new MonitorPublisher();
    const a = p.publish('agent.upsert', 'g', agent, { eventId: 'same' });
    expect(p.publish('agent.upsert', 'g', agent, { eventId: 'same' })).toBe(a);
    const es = await Promise.all(
      Array.from({ length: 10 }, (_, i) => Promise.resolve(p.publish('agent.activity', 'g', { label: String(i) }))),
    );
    expect(es.map((e) => e.cursor.sequence)).toEqual(Array.from({ length: 10 }, (_, i) => String(i + 2)));
  });
  it('projects the deterministic 50-agent fixture in identity order', () => {
    const p = new MonitorPublisher();
    for (const a of deterministicAgents()) p.publish('agent.upsert', a.agentGroupId, { ...a });
    expect(p.snapshot().agents).toHaveLength(50);
    expect(p.snapshot().agents.map((a) => a.agentGroupId)).toEqual(deterministicAgents().map((a) => a.agentGroupId));
  });
  it('reconciles gaps and epochs and resumes retained cursors', () => {
    const p = new MonitorPublisher(2);
    p.publish('agent.upsert', 'g', agent);
    const c = p.cursor();
    p.publish('agent.status', 'g', { status: 'blocked', hasBlockers: true });
    expect(p.resume(c).kind).toBe('events');
    expect(p.resume({ streamId: 'old', sequence: '1' })).toMatchObject({ kind: 'snapshot', reason: 'obsolete_epoch' });
    expect(p.resume({ streamId: p.streamId, sequence: '99' })).toMatchObject({ kind: 'snapshot', reason: 'gap' });
  });
  it('ignores duplicate IDs even after event retention expires', () => {
    const p = new MonitorPublisher(1);
    const first = p.publish('agent.upsert', 'g', agent, { eventId: 'old' });
    p.publish('agent.activity', 'g', { label: 'new' });
    expect(p.publish('agent.upsert', 'g', agent, { eventId: 'old' })).toBe(first);
    expect(p.cursor().sequence).toBe('2');
  });
  it('marks disconnect stale without changing status', () => {
    const p = new ClientProjection();
    const pub = new MonitorPublisher();
    pub.publish('agent.upsert', 'g', agent);
    p.applySnapshot(pub.snapshot());
    p.disconnect();
    expect(p.stale).toBe(true);
    expect(p.agents.get('g')?.status).toBe('idle');
  });
  it('delivers critical events immediately and coalesces noise within five seconds', () => {
    vi.useFakeTimers();
    const p = new MonitorPublisher();
    const seen: unknown[] = [];
    p.on('event', (e) => seen.push(e));
    const c = new ProgressCoalescer(p, 5000);
    c.push('tool.progress', 'g', { n: 1 });
    c.push('tool.progress', 'g', { n: 2 });
    c.push('error', 'g', { message: 'x' });
    expect(seen).toHaveLength(1);
    vi.advanceTimersByTime(4999);
    expect(seen).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(seen).toHaveLength(2);
    expect((seen[1] as { coalescedCount: number }).coalescedCount).toBe(2);
    vi.useRealTimers();
  });
  it('never classifies status, command, chat, errors, or terminal tools as droppable', () => {
    for (const type of [
      'agent.status',
      'command.ack',
      'command.success',
      'command.failure',
      'chat.in',
      'chat.out',
      'error',
      'tool.complete',
    ] as const)
      expect(MonitorPublisher.isDroppable(type)).toBe(false);
  });
  it('publishes normal events synchronously under the two second objective', () => {
    const p = new MonitorPublisher();
    let received = 0;
    const start = Date.now();
    p.once('event', () => {
      received = Date.now() - start;
    });
    p.publish('output', 'g', { text: 'x' });
    expect(received).toBeLessThan(2000);
  });
});
