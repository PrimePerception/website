/** Transitional adapter: replace before Runpod retires GraphQL in January 2027. */
const ENDPOINT = 'https://api.runpod.io/graphql';
export const TELEMETRY_MAX_AGE = 180_000;
export const ACTIVITY_QUERY = `query WorkbenchActivity {
  myself { pods {
    desiredStatus
    gpuCount
    runtime { gpus { gpuUtilPercent } }
    latestTelemetry { state time }
  } }
}`;

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/** Returns only the approved aggregate. Malformed or incomplete telemetry fails closed. */
export function aggregateTelemetry(payload: unknown, now = Date.now()): number | null {
  const envelope = object(payload);
  if (!envelope || ('errors' in envelope && (!Array.isArray(envelope.errors) || envelope.errors.length > 0)))
    return null;
  const pods = object(object(envelope.data)?.myself)?.pods;
  if (!Array.isArray(pods)) return null;
  const values: number[] = [];
  for (const value of pods) {
    const pod = object(value);
    if (!pod || typeof pod.desiredStatus !== 'string') return null;
    const desired = pod.desiredStatus.toUpperCase();
    if (!['RUNNING', 'EXITED', 'STOPPED', 'TERMINATED'].includes(desired)) return null;
    if (desired !== 'RUNNING') {
      // Desired state is a target: a stop request can coexist with a still-running GPU.
      // A remaining runtime or contradictory/partial telemetry cannot confirm an empty workbench.
      if (pod.runtime !== undefined && pod.runtime !== null) return null;
      if (pod.latestTelemetry !== undefined && pod.latestTelemetry !== null) {
        const stopped = object(pod.latestTelemetry);
        if (
          !stopped ||
          typeof stopped.state !== 'string' ||
          !['EXITED', 'STOPPED', 'TERMINATED'].includes(stopped.state.toUpperCase()) ||
          typeof stopped.time !== 'string'
        )
          return null;
        const measured = Date.parse(stopped.time);
        if (!Number.isFinite(measured) || now - measured > TELEMETRY_MAX_AGE || measured - now > 60_000) return null;
      }
      continue;
    }
    if (typeof pod.gpuCount !== 'number' || !Number.isInteger(pod.gpuCount) || pod.gpuCount < 0) return null;
    if (pod.gpuCount === 0) continue;
    const telemetry = object(pod.latestTelemetry);
    if (!telemetry || typeof telemetry.time !== 'string' || typeof telemetry.state !== 'string') return null;
    const measured = Date.parse(telemetry.time);
    if (!Number.isFinite(measured) || now - measured > TELEMETRY_MAX_AGE || measured - now > 60_000) return null;
    if (telemetry.state.toUpperCase() !== 'RUNNING') return null;
    const gpus = object(pod.runtime)?.gpus;
    if (!Array.isArray(gpus) || gpus.length !== pod.gpuCount) return null;
    for (const gpu of gpus) {
      const percent = object(gpu)?.gpuUtilPercent;
      if (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0 || percent > 100) return null;
      values.push(percent);
    }
  }
  return values.length ? Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10 : 0;
}

export async function collectUtilization(key: string | undefined, now = Date.now()): Promise<number | null> {
  if (!key) return null;
  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: ACTIVITY_QUERY }),
      redirect: 'error',
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok || !response.body) return null;
    const reader = response.body.getReader();
    let text = '';
    let bytes = 0;
    const decoder = new TextDecoder();
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 1_048_576) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
    return aggregateTelemetry(JSON.parse(text), now);
  } catch {
    // Provider errors, including their messages and payloads, never cross this boundary.
    return null;
  }
}
