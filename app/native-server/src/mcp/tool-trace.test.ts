import { describe, expect, it, jest, afterEach } from '@jest/globals';
import { traceToolCall } from './tool-trace';

describe('opt-in browser tool trace', () => {
  const original = process.env.WEBCLAW_TOOL_TRACE;
  afterEach(() => {
    if (original === undefined) delete process.env.WEBCLAW_TOOL_TRACE;
    else process.env.WEBCLAW_TOOL_TRACE = original;
    jest.restoreAllMocks();
  });

  it('does not log or change the result by default', async () => {
    delete process.env.WEBCLAW_TOOL_TRACE;
    const log = jest.spyOn(console, 'info').mockImplementation(() => {});
    const value = { content: [], isError: false };
    expect(await traceToolCall('chrome_extract', () => Promise.resolve(value))).toBe(value);
    expect(log).not.toHaveBeenCalled();
  });

  it('records bounded duration and outcome but no sensitive arguments or result body', async () => {
    process.env.WEBCLAW_TOOL_TRACE = '1';
    const log = jest.spyOn(console, 'info').mockImplementation(() => {});
    const secret = 'SECRET_URL_AND_FORM_VALUE';
    const result = { content: [{ type: 'text', text: secret }], isError: false };
    expect(await traceToolCall('chrome_extract', () => Promise.resolve(result))).toBe(result);
    const record = JSON.parse(String(log.mock.calls[0][0]));
    expect(record).toEqual(
      expect.objectContaining({
        kind: 'webclaw_tool_span',
        tool: 'chrome_extract',
        outcome: 'success',
      }),
    );
    expect(record.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(record.elapsedMs).toBeLessThan(10000);
    expect(record.traceId).toMatch(/^[a-f0-9-]{36}$/);
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
  });

  it('records rejected tool result without content', async () => {
    process.env.WEBCLAW_TOOL_TRACE = '1';
    const log = jest.spyOn(console, 'info').mockImplementation(() => {});
    const result = { content: [{ type: 'text', text: 'SECRET_ERROR' }], isError: true };
    await traceToolCall('chrome_navigate', () => Promise.resolve(result));
    expect(JSON.parse(String(log.mock.calls[0][0])).outcome).toBe('error');
    expect(JSON.stringify(log.mock.calls)).not.toContain('SECRET_ERROR');
  });

  it('records timeout rejection without logging the exception message', async () => {
    process.env.WEBCLAW_TOOL_TRACE = '1';
    const log = jest.spyOn(console, 'info').mockImplementation(() => {});
    await expect(
      traceToolCall('chrome_navigate', () => Promise.reject(new Error('SECRET_TIMEOUT'))),
    ).rejects.toThrow('SECRET_TIMEOUT');
    expect(JSON.parse(String(log.mock.calls[0][0])).outcome).toBe('thrown');
    expect(JSON.stringify(log.mock.calls)).not.toContain('SECRET_TIMEOUT');
  });

  it('logs thrown errors without message and rethrows', async () => {
    process.env.WEBCLAW_TOOL_TRACE = '1';
    const log = jest.spyOn(console, 'info').mockImplementation(() => {});
    await expect(
      traceToolCall('chrome_extract', () => Promise.reject(new Error('SECRET_ERROR'))),
    ).rejects.toThrow('SECRET_ERROR');
    expect(JSON.parse(String(log.mock.calls[0][0])).outcome).toBe('thrown');
    expect(JSON.stringify(log.mock.calls)).not.toContain('SECRET_ERROR');
  });
});
