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
  it('deduplicates retained IDs and accepts an ID again after its event is evicted', () => {
    const p = new MonitorPublisher(1);
    const first = p.publish('agent.upsert', 'g', agent, { eventId: 'old' });
    expect(p.publish('agent.upsert', 'g', agent, { eventId: 'old' })).toBe(first);
    p.publish('agent.activity', 'g', { label: 'new' });
    const reused = p.publish('agent.upsert', 'g', agent, { eventId: 'old' });
    expect(reused).not.toBe(first);
    expect(reused.cursor.sequence).toBe('3');
  });
  it('keeps retained history and dedupe memory at the same configured bound', () => {
    const p = new MonitorPublisher(3);
    for (let i = 0; i < 100; i++) p.publish('output', 'g', { i }, { eventId: `event-${i}` });
    expect(p.historyStats()).toEqual({ retainedEvents: 3, dedupeIds: 3 });
    expect(() => new MonitorPublisher(0)).toThrow('retention_must_be_positive_integer');
  });
  it('drops prior-session history at rollover and retains a contiguous reconnect suffix', () => {
    const p = new MonitorPublisher(10);
    p.publish('agent.upsert', 'a', agent, { sessionId: 'session-1', eventId: 's1' });
    const beforeOldActivity = p.cursor();
    p.publish('agent.activity', 'a', { label: 'old' }, { sessionId: 'session-1', eventId: 'old-activity' });
    const immediatelyBeforeRollover = p.cursor();
    const rollover = p.publish('agent.upsert', 'a', agent, { sessionId: 'session-2', eventId: 's2' });

    expect(p.historyStats()).toEqual({ retainedEvents: 1, dedupeIds: 1 });
    expect(p.resume(beforeOldActivity)).toMatchObject({ kind: 'snapshot', reason: 'gap' });
    expect(p.resume(immediatelyBeforeRollover)).toEqual({ kind: 'events', events: [rollover] });
    expect(p.snapshot().agents[0]?.sessionId).toBe('session-2');
  });
  it('preserves history for same-session upserts and expires old-session dedupe at rollover', () => {
    const p = new MonitorPublisher(10);
    const original = p.publish('agent.upsert', 'a', agent, { sessionId: 'session-1', eventId: 'session-event' });
    p.publish('agent.activity', 'a', { label: 'working' });
    p.publish('agent.upsert', 'a', { ...agent, status: 'in_progress' }, { sessionId: 'session-1' });
    expect(p.historyStats()).toEqual({ retainedEvents: 3, dedupeIds: 3 });

    p.publish('agent.upsert', 'a', agent, { sessionId: 'session-2' });
    const reused = p.publish('output', 'a', { text: 'new session' }, { eventId: 'session-event' });
    expect(reused).not.toBe(original);
    expect(p.historyStats()).toEqual({ retainedEvents: 2, dedupeIds: 2 });
  });
  it('uses snapshot reconciliation after an interleaved session rollover without exposing cursor holes', () => {
    const p = new MonitorPublisher(10);
    p.publish('agent.upsert', 'a', agent, { sessionId: 'a-1' });
    const reconnect = p.cursor();
    p.publish('agent.upsert', 'b', agent, { sessionId: 'b-1' });
    p.publish('agent.activity', 'a', { label: 'old' });
    p.publish('agent.activity', 'b', { label: 'current' });
    p.publish('agent.upsert', 'a', agent, { sessionId: 'a-2' });
    p.publish('agent.status', 'b', { status: 'idle' });

    expect(p.resume(reconnect)).toMatchObject({ kind: 'snapshot', reason: 'gap' });
    expect(p.snapshot().agents.map((item) => item.agentGroupId)).toEqual(['a', 'b']);
    expect(p.historyStats()).toEqual({ retainedEvents: 2, dedupeIds: 2 });
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
    expect(seen).toHaveLength(2);
    expect((seen[0] as { coalescedCount: number }).coalescedCount).toBe(2);
    expect((seen[1] as { type: string }).type).toBe('error');
    c.push('agent.activity', 'g', { label: 'one' });
    c.push('agent.activity', 'g', { label: 'two' });
    vi.advanceTimersByTime(4999);
    expect(seen).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(seen).toHaveLength(3);
    expect((seen[2] as { coalescedCount: number }).coalescedCount).toBe(2);
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
  it('preserves blockers without evidence and applies authoritative boolean clears independently of status', () => {
    const p = new MonitorPublisher();
    p.publish('agent.upsert', 'g', { ...agent, hasBlockers: true });
    p.publish('agent.status', 'g', { status: 'idle' });
    expect(p.snapshot().agents[0]).toMatchObject({ status: 'idle', hasBlockers: true });
    p.publish('agent.status', 'g', { status: 'in_progress', hasBlockers: false });
    expect(p.snapshot().agents[0]).toMatchObject({ status: 'in_progress', hasBlockers: false });
    p.publish('agent.status', 'g', { status: 'blocked', hasBlockers: false });
    expect(p.snapshot().agents[0]).toMatchObject({ status: 'blocked', hasBlockers: false });
  });
  it('applies real capability/activity updates and converges through resume snapshots', () => {
    const p = new MonitorPublisher();
    p.publish('agent.upsert', 'g', { ...agent, reasoningAvailability: 'unknown' });
    p.publish('agent.activity', 'g', { label: 'capabilities', reasoning: 'summary' });
    p.publish('reasoning.progress', 'g', { availability: 'full' });
    expect(p.snapshot().agents[0].reasoningAvailability).toBe('full');
    const resumed = p.resume();
    expect(resumed).toMatchObject({ kind: 'snapshot', snapshot: { agents: [{ reasoningAvailability: 'full' }] } });
  });
  it('redacts structured and free-text secrets before projection and retention without changing event identity', () => {
    const p = new MonitorPublisher();
    const id = 'sk-abcdefghijk';
    const published = p.publish(
      'agent.upsert',
      'g',
      { ...agent, activity: 'token=super-secret-value', metadata: { apiKey: 'secret-value' } },
      { eventId: id },
    );
    expect(published.eventId).toBe(id);
    expect(published.payload).toMatchObject({
      activity: 'token=[REDACTED]',
      metadata: { apiKey: '[REDACTED]' },
    });
    expect(p.snapshot().agents[0]?.activity).toBe('token=[REDACTED]');
    expect(p.resume({ streamId: p.streamId, sequence: '0' })).toMatchObject({
      kind: 'events',
      events: [{ eventId: id, payload: { metadata: { apiKey: '[REDACTED]' } } }],
    });
    expect(p.publish('agent.upsert', 'g', agent, { eventId: id })).toBe(published);
  });
  it('rejects unsupported status evidence before projection', () => {
    const p = new MonitorPublisher();
    p.publish('agent.upsert', 'g', agent);
    const before = p.cursor();
    expect(() => p.publish('agent.status', 'g', { status: 'invented' })).toThrow('invalid_payload');
    expect(p.cursor()).toEqual(before);
    expect(p.snapshot().agents[0]?.status).toBe('idle');
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
