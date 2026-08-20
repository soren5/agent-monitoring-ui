/**
 * Host-side container config for the `deepseek` provider.
 *
 * DeepSeek is reached as a native OpenAI-compatible endpoint. The endpoint is
 * FIXED — a host constant, never a group config field — so an agent cannot
 * turn the provider into an arbitrary network client. Requests are routed
 * through the OneCLI gateway (every spawn applies the proxy), which injects
 * the real credential in flight from the vault secret whose host-pattern
 * matches `api.deepseek.com`. The container only ever sends to the fixed
 * base URL and never holds a key.
 *
 * Model selection is host-owned and deterministic: `deepseek` agents run the
 * checked-in model allowlist (see container/agent-runner/src/providers/
 * deepseek.ts), not free-form group input.
 */
import { registerProviderContainerConfig } from './provider-container-registry.js';

function mergeNoProxy(current: string | undefined, additions: string): string {
  if (!current?.trim()) return additions;
  const parts = new Set(
    current
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  );
  for (const addition of additions.split(',')) {
    const trimmed = addition.trim();
    if (trimmed) parts.add(trimmed);
  }
  return [...parts].join(',');
}

registerProviderContainerConfig('deepseek', (ctx) => ({
  env: {
    // Fixed endpoint — DeepSeek's OpenAI-compatible surface. The container
    // provider resolves it from this env var so the host stays the single
    // source of the endpoint; it is not read from group config.
    DEEPSEEK_BASE_URL: 'https://api.deepseek.com/v1',
    // OneCLI sets HTTP(S)_PROXY for credentialed egress. Localhost must stay
    // proxy-bypassed so in-container tools reach their own loopback. DeepSeek
    // itself is NOT bypassed — its traffic rides the gateway.
    NO_PROXY: mergeNoProxy(ctx.hostEnv.NO_PROXY, 'localhost,127.0.0.1'),
    no_proxy: mergeNoProxy(ctx.hostEnv.no_proxy, 'localhost,127.0.0.1'),
  },
}));
