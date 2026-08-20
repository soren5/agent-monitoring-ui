import { afterEach, describe, expect, it, vi } from 'vitest';

import { ensureLocalModelBridge, verifyLocalModelBridge } from '../../egress-lockdown.js';
import { probeLocalModel } from './local-model-health.js';

vi.mock('../../egress-lockdown.js', () => ({
  ensureLocalModelBridge: vi.fn(),
  verifyLocalModelBridge: vi.fn(() => true),
}));

const originalFetch = globalThis.fetch;
const model = 'google/gemma-4-12b-qat';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.mocked(ensureLocalModelBridge).mockReset();
  vi.mocked(verifyLocalModelBridge).mockReset();
  vi.mocked(verifyLocalModelBridge).mockReturnValue(true);
});

describe('probeLocalModel', () => {
  it('accepts an approved model only after inventory and bounded completion succeed', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ data: [{ id: model }] }))
      .mockResolvedValueOnce(json({ choices: [{ message: { content: 'OK' } }] }));
    globalThis.fetch = fetchMock;

    await expect(probeLocalModel(model)).resolves.toEqual({ ok: true });
    expect(ensureLocalModelBridge).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenNthCalledWith(1, 'http://127.0.0.1:1234/v1/models', expect.any(Object));
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:1234/v1/chat/completions',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('reports an unavailable endpoint without trying to provision through it', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('connection refused'));
    await expect(probeLocalModel(model)).resolves.toEqual({ ok: false, category: 'endpoint' });
  });

  it('rejects an approved model that is missing from host inventory', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(json({ data: [] }));
    await expect(probeLocalModel(model)).resolves.toEqual({ ok: false, category: 'inventory' });
  });

  it('rejects an invalid completion response', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ data: [{ id: model }] }))
      .mockResolvedValueOnce(json({ choices: [] }));
    await expect(probeLocalModel(model)).resolves.toEqual({ ok: false, category: 'completion' });
  });

  it('fails closed when the isolated container route cannot reach the fixed bridge', async () => {
    vi.mocked(verifyLocalModelBridge).mockReturnValue(false);
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ data: [{ id: model }] }))
      .mockResolvedValueOnce(json({ choices: [{ message: { content: 'OK' } }] }));
    await expect(probeLocalModel(model)).resolves.toEqual({ ok: false, category: 'container_route' });
  });

  it('fails closed when the host cannot establish the fixed bridge', async () => {
    vi.mocked(ensureLocalModelBridge).mockImplementation(() => {
      throw new Error('bridge unavailable');
    });
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ data: [{ id: model }] }))
      .mockResolvedValueOnce(json({ choices: [{ message: { content: 'OK' } }] }));

    await expect(probeLocalModel(model)).resolves.toEqual({ ok: false, category: 'container_route' });
    expect(verifyLocalModelBridge).not.toHaveBeenCalled();
  });
});
