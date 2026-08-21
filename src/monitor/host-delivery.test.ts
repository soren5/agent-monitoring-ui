import { describe, expect, it, vi } from 'vitest';
import type { Session } from '../types.js';
import { createHostMessageDelivery } from './host-delivery.js';
const session = { id: 's', agent_group_id: 'g' } as Session;
describe('host monitor message delivery', () => {
  it('reports inactive agents without writing', async () => {
    const write = vi.fn();
    const d = createHostMessageDelivery({ find: () => undefined, write, wake: async () => true });
    expect(await d('g', 'hello')).toEqual({ delivered: false, detail: 'inactive_agent' });
    expect(write).not.toHaveBeenCalled();
  });
  it('uses existing host inbound and wake mechanics for active agents', async () => {
    const write = vi.fn();
    const wake = vi.fn(async () => true);
    const d = createHostMessageDelivery({ find: () => session, write, wake });
    expect(await d('g', 'hello')).toEqual({ delivered: true });
    expect(write).toHaveBeenCalledWith(
      'g',
      's',
      expect.objectContaining({ kind: 'agent', content: 'hello', trigger: 1 }),
    );
    expect(wake).toHaveBeenCalledWith(session);
  });
});
