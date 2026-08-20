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

// opencode drives the agentic loop (read/bash/edit/write tools) and the model
// rides a backend: LM Studio on the host for local models, or DeepSeek's API
// via the OneCLI gateway proxy for deepseek. The harness spawns its own
// loopback `opencode serve`; NO_PROXY keeps loopback + the local model bridge
// out of the proxy, while DeepSeek traffic stays proxied so the gateway
// injects the credential.
registerProviderContainerConfig('opencode', (ctx) => ({
  env: {
    LOCAL_MODEL_BASE_URL: 'http://local-model.bridge:1234/v1',
    DEEPSEEK_BASE_URL: 'https://api.deepseek.com/v1',
    NO_PROXY: mergeNoProxy(ctx.hostEnv.NO_PROXY, 'local-model.bridge,localhost,127.0.0.1'),
    no_proxy: mergeNoProxy(ctx.hostEnv.no_proxy, 'local-model.bridge,localhost,127.0.0.1'),
  },
}));
