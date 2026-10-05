import { describe, expect, test, jest } from '@jest/globals';
import {
  decideWithTev1,
  buildTev1Payload,
  selectTev1Candidates,
  Tev1ClientError,
} from './tev1-client';

describe('Tev1 client', () => {
  const candidates = [{ id: 'e1', text: 'Continue', enabled: true }];
  test('builds native systemone typed-choice payload', () => {
    expect(buildTev1Payload('click Continue', candidates)).toMatchObject({
      model: 'tev1:4b-q4_K_M',
      keep_alive: '5m',
      state: { goal: 'click Continue', candidates },
      questions: {
        decision: {
          type: 'choice',
          criteria: { e1: expect.any(String), escalate: expect.any(String) },
        },
      },
    });
  });
  test('accepts only an offered choice or explicit escalation', async () => {
    const fetcher = jest.fn(
      async () =>
        new Response(JSON.stringify({ answers: { decision: { type: 'choice', choice: 'e1' } } }), {
          status: 200,
        }),
    );
    await expect(
      decideWithTev1('click Continue', candidates, {
        enabled: true,
        fetcher: fetcher as typeof fetch,
      }),
    ).resolves.toBe('e1');
    const unknown = async () =>
      new Response(JSON.stringify({ answers: { decision: { type: 'choice', choice: 'e9' } } }), {
        status: 200,
      });
    await expect(
      decideWithTev1('click Continue', candidates, { enabled: true, fetcher: unknown }),
    ).rejects.toBeInstanceOf(Tev1ClientError);
  });
  test.each([
    ['disabled', { enabled: false }],
    ['empty', { enabled: true }],
  ])('does not call model for %s input', async (_name, options) => {
    const fetcher = jest.fn();
    await expect(
      decideWithTev1('click Continue', _name === 'empty' ? [] : candidates, {
        ...options,
        fetcher: fetcher as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(Tev1ClientError);
    expect(fetcher).not.toHaveBeenCalled();
  });
  test('preserves a bounded HTTP error body so protocol rejections are diagnosable', async () => {
    const fetcher = async () =>
      new Response(JSON.stringify({ error: 'criteria must contain 2–26 candidates' }), {
        status: 400,
      });
    await expect(
      decideWithTev1('click Continue', candidates, { enabled: true, fetcher }),
    ).rejects.toThrow('criteria must contain 2–26 candidates');
  });
  test('redacts secret-like values and truncates excessive HTTP error bodies', async () => {
    const longError = JSON.stringify({ error: 'password=supersecret ' + 'x'.repeat(700) });
    const fetcher = async () => new Response(longError, { status: 400 });
    let message = '';
    try {
      await decideWithTev1('click Continue', candidates, { enabled: true, fetcher });
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain('password=[REDACTED]');
    expect(message).not.toContain('supersecret');
    expect(message.length).toBeLessThan(600);
  });
  test('uses a configurable deadline and reports the limit distinctly', async () => {
    const fetcher = async (_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      });
    await expect(
      decideWithTev1('click Continue', candidates, { enabled: true, timeoutMs: 5, fetcher }),
    ).rejects.toThrow('Tev1 timeout after 5ms');
  });
  test('selects only 25 goal-relevant candidates with stable order on ties', () => {
    const many = Array.from({ length: 30 }, (_, index) => ({
      id: `e${index + 1}`,
      text: index === 28 ? 'Big Buck Bunny official video' : `Unrelated item ${index + 1}`,
      enabled: true,
    }));
    const selected = selectTev1Candidates('find Big Buck Bunny official video', many);
    expect(selected).toHaveLength(25);
    expect(selected.map((candidate) => candidate.id)).toContain('e29');
    expect(selected.map((candidate) => candidate.id)).not.toContain('e30');
  });
  test('rejects a criteria set exceeding the service maximum without sending', async () => {
    const fetcher = jest.fn() as typeof fetch;
    const tooMany = Array.from({ length: 26 }, (_, index) => ({
      id: `e${index + 1}`,
      text: `Candidate ${index + 1}`,
      enabled: true,
    }));
    await expect(decideWithTev1('choose', tooMany, { enabled: true, fetcher })).rejects.toThrow(
      'maximum 25 selectable candidates',
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
});
