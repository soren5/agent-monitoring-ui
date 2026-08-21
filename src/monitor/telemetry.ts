import type { MonitorEventType, ReasoningAvailability } from './protocol.js';

export interface ProviderTelemetryCapabilities {
  reasoning: ReasoningAvailability;
  toolProgress: boolean;
}
export type TelemetrySink = (type: MonitorEventType, agentGroupId: string, payload: Record<string, unknown>) => void;
let runtimeSink: TelemetrySink | undefined;
export function setRuntimeTelemetrySink(sink: TelemetrySink | undefined): void {
  runtimeSink = sink;
}
export function emitRuntimeTelemetry(
  type: MonitorEventType,
  agentGroupId: string,
  payload: Record<string, unknown>,
): void {
  runtimeSink?.(type, agentGroupId, payload);
}

export function providerCapabilities(provider: string): ProviderTelemetryCapabilities {
  switch (provider) {
    case 'claude':
      return { reasoning: 'summary', toolProgress: true };
    case 'codex':
      return { reasoning: 'activity_only', toolProgress: true };
    case 'deepseek':
      return { reasoning: 'none', toolProgress: false };
    default:
      return { reasoning: 'unknown', toolProgress: false };
  }
}

/** Append-only runner adapter; structured telemetry never enters user-visible chat. */
export class RunnerTelemetry {
  constructor(
    private readonly sink: TelemetrySink,
    readonly agentGroupId: string,
    readonly provider: string,
  ) {}
  activity(label: string): void {
    this.sink('agent.activity', this.agentGroupId, { label });
  }
  reasoning(content?: string): void {
    const availability = providerCapabilities(this.provider).reasoning;
    const payload: Record<string, unknown> = { availability };
    if ((availability === 'full' || availability === 'summary') && content) payload.content = content;
    this.sink('reasoning.progress', this.agentGroupId, payload);
  }
  tool(type: 'start' | 'progress' | 'complete', name: string, detail: Record<string, unknown> = {}): void {
    this.sink(`tool.${type}` as MonitorEventType, this.agentGroupId, { name, ...detail });
  }
  error(message: string): void {
    this.sink('error', this.agentGroupId, { message });
  }
}
