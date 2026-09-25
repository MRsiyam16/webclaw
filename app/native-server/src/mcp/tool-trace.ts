import { randomUUID } from 'crypto';
import { performance } from 'perf_hooks';

/** Local diagnostic span. Deliberately never serializes arguments, responses, or errors. */
export async function traceToolCall<T extends { isError?: boolean }>(
  name: string,
  operation: () => Promise<T>,
): Promise<T> {
  if (process.env.WEBCLAW_TOOL_TRACE !== '1') return operation();
  const started = performance.now();
  const traceId = randomUUID();
  let outcome = 'thrown';
  try {
    const result = await operation();
    outcome = result?.isError ? 'error' : 'success';
    return result;
  } finally {
    // Tool names are normally static, but don't allow a caller-supplied name to leak content.
    const tool = /^chrome_[a-z_]+$/.test(name) ? name : 'unknown';
    console.info(
      JSON.stringify({
        kind: 'webclaw_tool_span',
        traceId,
        tool,
        outcome,
        elapsedMs: Math.round((performance.now() - started) * 1000) / 1000,
      }),
    );
  }
}
