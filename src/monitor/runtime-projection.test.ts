import { describe, expect, it } from 'vitest';
import { mapPersistedContainerStatus, seedReasoningAvailability } from './runtime.js';

describe('authoritative monitor projection inputs', () => {
  it('maps every persisted container status without inventing evidence', () => {
    expect(mapPersistedContainerStatus('starting')).toBe('starting');
    expect(mapPersistedContainerStatus('running')).toBe('in_progress');
    expect(mapPersistedContainerStatus('idle')).toBe('idle');
    expect(mapPersistedContainerStatus('stopping')).toBe('stopping');
    expect(mapPersistedContainerStatus('stopped')).toBe('stopped');
    expect(mapPersistedContainerStatus('failed')).toBe('failed');
    expect(mapPersistedContainerStatus('blocked')).toBe('unknown');
    expect(mapPersistedContainerStatus('waiting')).toBe('unknown');
    expect(mapPersistedContainerStatus('contradictory')).toBe('unknown');
    expect(mapPersistedContainerStatus(null)).toBe('stopped');
  });
  it('seeds only capabilities known from effective provider configuration', () => {
    expect(seedReasoningAvailability('openai-compatible', null)).toBe('none');
    expect(seedReasoningAvailability('codex', 'none')).toBe('none');
    expect(seedReasoningAvailability('codex', 'high')).toBe('unknown');
    expect(seedReasoningAvailability('claude', null)).toBe('unknown');
    expect(seedReasoningAvailability('opencode', null)).toBe('unknown');
    expect(seedReasoningAvailability('deepseek', null)).toBe('unknown');
  });
});
