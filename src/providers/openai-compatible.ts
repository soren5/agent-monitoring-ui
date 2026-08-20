import { registerProviderContainerConfig } from './provider-container-registry.js';

// LM Studio runs on the host. This is deliberately fixed rather than copied
// from group config, so an agent cannot turn a local-model provider into an
// arbitrary network client. No credential is required or passed to containers.
registerProviderContainerConfig('openai-compatible', () => ({
  env: {
    // The fixed bridge is the sole local-model route exposed to an agent
    // container. It is attached to the isolated egress network and forwards
    // only approved OpenAI-compatible calls to LM Studio.
    LOCAL_MODEL_BASE_URL: 'http://local-model.bridge:1234/v1',
    NO_PROXY: 'local-model.bridge,localhost,127.0.0.1',
  },
}));
