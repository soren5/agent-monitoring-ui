import { describe, expect, it, vi } from 'vitest';
import { RunnerTelemetry, providerCapabilities } from './telemetry.js';
describe('runner telemetry', () => {
  it('maps provider gaps explicitly', () => expect(providerCapabilities('other').reasoning).toBe('unknown'));
  it('does not expose activity-only reasoning content', () => {
    const sink = vi.fn();
    new RunnerTelemetry(sink, 'g', 'codex').reasoning('secret');
    expect(sink).toHaveBeenCalledWith('reasoning.progress', 'g', { availability: 'activity_only' });
  });
});
