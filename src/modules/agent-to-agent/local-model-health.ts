/** Fixed, host-owned LM Studio health probe. No endpoint is agent-configurable. */
import { ensureLocalModelBridge, verifyLocalModelBridge } from '../../egress-lockdown.js';
const HOST_BASE_URL = 'http://127.0.0.1:1234/v1';
const APPROVED_MODELS = new Set(['google/gemma-4-12b-qat', 'qwen/qwen3.6-27b']);

export type LocalModelHealth =
  | { ok: true }
  | { ok: false; category: 'endpoint' | 'inventory' | 'completion' | 'container_route' };

async function boundedFetch(path: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    return await fetch(`${HOST_BASE_URL}${path}`, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

/** Validate endpoint, approved-model inventory, and one fixed bounded completion. */
export async function probeLocalModel(model: string): Promise<LocalModelHealth> {
  if (!APPROVED_MODELS.has(model)) return { ok: false, category: 'inventory' };
  let models: Response;
  try {
    models = await boundedFetch('/models');
  } catch {
    return { ok: false, category: 'endpoint' };
  }
  if (!models.ok) return { ok: false, category: 'endpoint' };
  let inventory: { data?: Array<{ id?: string }> };
  try {
    inventory = (await models.json()) as { data?: Array<{ id?: string }> };
  } catch {
    return { ok: false, category: 'inventory' };
  }
  if (!inventory.data?.some((entry) => entry.id === model)) return { ok: false, category: 'inventory' };
  let completion: Response;
  try {
    completion = await boundedFetch('/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Reply exactly OK.' }],
        max_tokens: 4,
        stream: false,
      }),
    });
  } catch {
    return { ok: false, category: 'completion' };
  }
  if (!completion.ok) return { ok: false, category: 'completion' };
  try {
    const body = (await completion.json()) as { choices?: unknown[] };
    if (!Array.isArray(body.choices) || body.choices.length === 0) return { ok: false, category: 'completion' };
    // A first local-model provision may be the first code path that needs the
    // fixed sidecar. Create/validate that host-owned route before probing it;
    // the agent itself never receives a way to create or configure the bridge.
    try {
      ensureLocalModelBridge();
    } catch {
      return { ok: false, category: 'container_route' };
    }
    return verifyLocalModelBridge(model) ? { ok: true } : { ok: false, category: 'container_route' };
  } catch {
    return { ok: false, category: 'completion' };
  }
}
