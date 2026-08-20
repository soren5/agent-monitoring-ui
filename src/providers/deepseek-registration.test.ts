/**
 * Integration test for the deepseek provider's HOST-side reach-in: the
 * self-registration import in the src/providers/index.ts barrel. Importing the
 * barrel runs deepseek.ts's top-level registerProviderContainerConfig('deepseek', …);
 * without that import line the host never wires the provider's fixed endpoint
 * env into agent containers.
 *
 * BARREL-ONLY: it imports the real barrel (./index.js), never ./deepseek.js
 * directly, then asserts the registry actually contains the provider.
 */
import { describe, it, expect } from 'vitest';

import { getProviderContainerConfig, listProviderContainerConfigNames } from './provider-container-registry.js';
import './index.js'; // the real host provider barrel — triggers each provider's self-registration

describe('deepseek provider host registration', () => {
  it('registers deepseek host container-config via the barrel', () => {
    expect(listProviderContainerConfigNames()).toContain('deepseek');
  });

  it('injects only the fixed DeepSeek endpoint and a localhost NO_PROXY', () => {
    const contribution = getProviderContainerConfig('deepseek')!({
      sessionDir: '/sess',
      agentGroupId: 'ag-test',
      groupDir: '/group',
      selectedSkills: [],
      hostEnv: {},
    });
    expect(contribution.env?.DEEPSEEK_BASE_URL).toBe('https://api.deepseek.com/v1');
    expect(contribution.env?.NO_PROXY).toContain('localhost');
    expect(contribution.env?.NO_PROXY).not.toContain('api.deepseek.com');
    expect(Object.keys(contribution.env ?? {}).sort()).toEqual(['DEEPSEEK_BASE_URL', 'NO_PROXY', 'no_proxy']);
  });
});
