import { describe, expect, test } from '@jest/globals';
import {
  FastDecisionEngine,
  containsProhibitedGoal,
  findMatchingPauseKeyword,
  hasDuplicateClickableAccessibleName,
} from './fast-decision-engine';

describe('hasDuplicateClickableAccessibleName', () => {
  test('ignores text roles and detects duplicate names on different clickable roles', () => {
    expect(
      hasDuplicateClickableAccessibleName('[1] link "Reports"', 1, [
        '[1] link "Reports"',
        '[2] text "Reports"',
      ]),
    ).toBe(false);
    expect(
      hasDuplicateClickableAccessibleName('[1] link "Reports"', 1, [
        '[1] link "Reports"',
        '[2] button "Reports"',
      ]),
    ).toBe(true);
  });

  test('parses compact flags before clickable roles and accepts positional refs', () => {
    expect(
      hasDuplicateClickableAccessibleName('[1|e1] [selected] button "Reports"', 1, [
        '[1|e1] [selected] button "Reports"',
        '[2|e2] link "Reports"',
      ]),
    ).toBe(true);
  });

  test('uses only the primary quoted clickable name', () => {
    expect(
      hasDuplicateClickableAccessibleName('[1] link "Reports" href="/reports"', 1, [
        '[1] link "Reports" href="/reports"',
        '[2] link "Archive" title="Reports"',
      ]),
    ).toBe(false);
    expect(
      hasDuplicateClickableAccessibleName('[1] link "Reports"', 1, [
        '[1] link "Reports"',
        '[2] link "Reports archive"',
      ]),
    ).toBe(false);
  });

  test('checks all elements even when the duplicate is far below the first visible controls', () => {
    const elements = [
      '[1] button "Reports"',
      ...Array.from({ length: 7 }, (_, i) => `[${i + 2}] button "Reports archive ${i + 2}"`),
      '[9] link "Reports"',
    ];
    expect(hasDuplicateClickableAccessibleName(elements[0], 1, elements)).toBe(true);
  });
});

describe('native heuristic execution', () => {
  const callerFor =
    (treeString: string, calls: string[]) =>
    async (toolName: string, args: any = {}) => {
      calls.push(toolName);
      if (toolName === 'chrome_read_dom') {
        return {
          content: [
            {
              text: JSON.stringify({
                treeString,
                tabUrl: 'https://example.test',
                tabTitle: 'Example',
              }),
            },
          ],
        };
      }
      return {
        content: [{ text: JSON.stringify({ success: true, mutated: true, urlChanged: false }) }],
      };
    };

  test('executes a decisive safe click without any model/network client', async () => {
    const calls: string[] = [];
    const result = await new FastDecisionEngine('heuristic_only').run(
      { goal: 'click Continue' },
      callerFor('[1] button "Continue"', calls),
    );
    expect(result.status).toBe('done');
    expect(result.engine).toBe('heuristic');
    expect(calls).toEqual(['chrome_read_dom', 'chrome_interact_index']);
  });

  test('uses the decisive heuristic fast path even when Tev1 is enabled', async () => {
    const calls: string[] = [];
    const fetcher = jest.fn() as typeof fetch;
    const observed = {
      index: 1,
      ref: 'e1',
      frameId: 'top',
      isInteractive: true,
      isOccluded: false,
      role: 'button',
      attributes: {},
      text: 'Continue',
    };
    const result = await new FastDecisionEngine('auto', {
      tev1Enabled: true,
      tev1Fetch: fetcher,
    }).run({ goal: 'click Continue', tabId: 7 }, async (name) => {
      calls.push(name);
      if (name === 'chrome_read_dom')
        return {
          content: [
            {
              text: JSON.stringify({
                snapshotId: 'snap-fast',
                indexedElements: [observed],
                treeString: '[1|e1] button "Continue"',
              }),
            },
          ],
        };
      return {
        content: [{ text: JSON.stringify({ success: true, mutated: true, urlChanged: false }) }],
      };
    });
    expect(result.status).toBe('done');
    expect(result.localDecision?.reason).toMatch(/heuristic/i);
    expect(fetcher).not.toHaveBeenCalled();
    expect(calls).toEqual(['chrome_read_dom', 'chrome_interact_index']);
  });

  test('shortlists a goal-relevant candidate while preserving safe snapshot validation', async () => {
    const calls: Array<{ name: string; args: any }> = [];
    const fetcher = async (_url: string | URL | Request, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body));
      expect(payload.state.candidates).toHaveLength(25);
      expect(payload.state.candidates.map((candidate: any) => candidate.id)).toContain('e29');
      return new Response(
        JSON.stringify({ answers: { decision: { type: 'choice', choice: 'e29' } } }),
        { status: 200 },
      );
    };
    const result = await new FastDecisionEngine('auto', {
      tev1Enabled: true,
      tev1Fetch: fetcher as typeof fetch,
    }).run({ goal: 'find Big Buck Bunny official video', tabId: 7 }, async (name, args) => {
      calls.push({ name, args });
      if (name === 'chrome_read_dom') {
        const candidates = Array.from({ length: 30 }, (_, index) => ({
          index: index + 1,
          ref: `e${index + 1}`,
          frameId: 'top',
          isInteractive: true,
          isOccluded: false,
          role: 'button',
          attributes: {},
          text: index === 28 ? 'Big Buck Bunny official video' : `Recommendation ${index + 1}`,
        }));
        const treeString = candidates
          .map((candidate) => `[${candidate.index}|${candidate.ref}] button "${candidate.text}"`)
          .join('\n');
        return {
          content: [
            {
              text: JSON.stringify({
                snapshotId: 'snap-many',
                treeString,
                indexedElements: candidates,
              }),
            },
          ],
        };
      }
      return {
        content: [{ text: JSON.stringify({ success: true, mutated: true, urlChanged: false }) }],
      };
    });
    expect(result.status).toBe('done');
    expect(calls.find((call) => call.name === 'chrome_interact_index')?.args.index).toBe(29);
  });

  test.each([
    ['reset type', { type: 'reset' }, 'Reset'],
    ['reset type case', { type: 'RESET' }, 'Continue'],
    ['destructive aria label', { 'aria-label': 'Reset settings' }, 'Continue'],
    ['destructive title', { title: 'Delete account' }, 'Continue'],
    ['destructive visible text', {}, 'Clear all'],
    ['submit without authorization', { type: 'submit' }, 'Continue'],
  ])('excludes Tev1 candidate: %s', async (_label, attributes, text) => {
    const calls: string[] = [];
    const fetcher = jest.fn() as typeof fetch;
    const result = await new FastDecisionEngine('auto', {
      tev1Enabled: true,
      tev1Fetch: fetcher,
    }).run({ goal: 'click Continue', tabId: 7 }, async (name) => {
      calls.push(name);
      if (name === 'chrome_read_dom')
        return {
          content: [
            {
              text: JSON.stringify({
                snapshotId: 'snap-1',
                treeString: `[1|e1] button "${text}"`,
                indexedElements: [
                  {
                    index: 1,
                    ref: 'e1',
                    frameId: 'top',
                    isInteractive: true,
                    isOccluded: false,
                    role: 'button',
                    attributes,
                    text,
                  },
                ],
              }),
            },
          ],
        };
      return {};
    });
    expect(result.status).toBe('escalate');
    expect(calls).toEqual(['chrome_read_dom']);
    expect(fetcher).not.toHaveBeenCalled();
  });

  test('escalates without model or browser action when frame/snapshot provenance is absent', async () => {
    const calls: string[] = [];
    const fetcher = jest.fn() as typeof fetch;
    const result = await new FastDecisionEngine('auto', {
      tev1Enabled: true,
      tev1Fetch: fetcher,
    }).run({ goal: 'click Continue' }, async (name) => {
      calls.push(name);
      return {
        content: [
          {
            text: JSON.stringify({
              treeString: '[1|e1] button "Continue"',
              indexedElements: [
                { index: 1, ref: 'e1', isInteractive: true, role: 'button', attributes: {} },
              ],
            }),
          },
        ],
      };
    });
    expect(result.status).toBe('escalate');
    expect(calls).toEqual(['chrome_read_dom']);
  });

  test('blocks prohibited goals before browser execution', async () => {
    const calls: string[] = [];
    const result = await new FastDecisionEngine('auto').run(
      { goal: 'buy this item' },
      callerFor('[1] button "Buy"', calls),
    );
    expect(result.status).toBe('escalate');
    expect(calls).toEqual(['chrome_read_dom']);
  });

  test('requests full DOM on repeated reads so unchanged cache envelopes cannot erase context', async () => {
    const treeString = '[1|e1] button "Sample"\n[2|e2] button "Sample"';
    const receivedArgs: any[] = [];
    const run = () =>
      new FastDecisionEngine('heuristic_only').run(
        { goal: 'click Sample', tabId: 7 },
        async (toolName: string, args: any) => {
          if (toolName === 'chrome_read_dom') {
            receivedArgs.push(args);
            return {
              content: [
                {
                  text: JSON.stringify(
                    args.deltaOnly === false
                      ? { treeString, tabUrl: 'https://example.test', tabTitle: 'Example' }
                      : { unchanged: true, delta: { unchanged: true } },
                  ),
                },
              ],
            };
          }
          throw new Error('ambiguous target must not be clicked');
        },
      );

    const results = [await run(), await run()];
    for (const result of results) {
      expect(result.status).toBe('escalate');
      expect(result.localDecision?.candidateCount).toBeGreaterThan(0);
      expect(result.finalPage).toEqual({ url: 'https://example.test/', title: 'Example' });
      expect(result.currentElements).toHaveLength(2);
      expect(result.steps).toEqual([]);
    }
    expect(receivedArgs).toHaveLength(2);
    expect(receivedArgs.every((args) => args.deltaOnly === false)).toBe(true);
  });

  test('pauses on configured keyword before executing matching target', async () => {
    const calls: string[] = [];
    const result = await new FastDecisionEngine('heuristic_only').run(
      { goal: 'click Continue', pauseBeforeKeywords: ['Continue'] },
      callerFor('[1] button "Continue"', calls),
    );
    expect(result.status).toBe('paused');
    expect(calls).toEqual(['chrome_read_dom']);
  });
});

describe('deterministic regression guards', () => {
  const caller =
    (
      read: () => object,
      interaction: (tool: string, args: any) => object = () => ({
        success: true,
        mutated: false,
        urlChanged: false,
      }),
    ) =>
    async (tool: string, args: any = {}) => ({
      content: [
        { text: JSON.stringify(tool === 'chrome_read_dom' ? read() : interaction(tool, args)) },
      ],
    });

  test('does not report completion when a click has no mutation or URL change', async () => {
    const result = await new FastDecisionEngine('heuristic_only').run(
      { goal: 'click Continue' },
      caller(() => ({ treeString: '[1] button "Continue"', tabUrl: 'https://example.test' })),
    );
    expect(result.status).not.toBe('done');
  });

  test('recognizes a committed generic DOM delta when perceptive flags are quiet and does not re-click', async () => {
    const calls: string[] = [];
    const result = await new FastDecisionEngine('heuristic_only').run(
      { goal: 'Click the uniquely labeled button Open the blue fixture panel.' },
      async (tool: string) => {
        calls.push(tool);
        if (tool === 'chrome_read_dom')
          return {
            content: [
              {
                text: JSON.stringify({
                  treeString: '[1|e1] button "Open the blue fixture panel"',
                  tabUrl: 'file:///fixture.html',
                }),
              },
            ],
          };
        return {
          content: [
            {
              text: JSON.stringify({
                success: true,
                verdict: 'applied',
                urlChanged: false,
                perceptiveDelta: {
                  advanced: false,
                  questionChanged: false,
                  progressChanged: false,
                },
                delta: { changedNodes: 1 },
              }),
            },
          ],
        };
      },
    );
    expect(result.status).toBe('done');
    expect(result.steps?.[0]?.outcome).toContain('mutated:true');
    expect(calls.filter((name) => name === 'chrome_interact_index')).toHaveLength(1);
  });

  test('does not infer no mutation or retry when action response omits delta metadata', async () => {
    const calls: string[] = [];
    const result = await new FastDecisionEngine('heuristic_only').run(
      { goal: 'click Continue', maxSteps: 5 },
      async (tool: string) => {
        calls.push(tool);
        if (tool === 'chrome_read_dom')
          return {
            content: [
              {
                text: JSON.stringify({
                  treeString: '[1|e1] button "Continue"',
                  tabUrl: 'https://example.test',
                }),
              },
            ],
          };
        return {
          content: [
            {
              text: JSON.stringify({
                success: true,
                verdict: 'applied_unverified',
                urlChanged: false,
              }),
            },
          ],
        };
      },
    );
    expect(result.status).toBe('escalate');
    expect(result.reason).toMatch(/applied.*unverified/i);
    expect(result.steps?.[0]?.outcome).toContain('mutated:unknown');
    expect(result.localDecision?.tier).toBe('heuristic');
    expect(calls.filter((name) => name === 'chrome_interact_index')).toHaveLength(1);
  });

  test('does not classify a chained request as one-shot because the target label contains an action verb', async () => {
    const result = await new FastDecisionEngine('heuristic_only').run(
      { goal: 'click Continue then open Settings' },
      caller(
        () => ({ treeString: '[1|e1] button "Continue"', tabUrl: 'https://example.test' }),
        () => ({ success: true, mutated: true, urlChanged: false }),
      ),
    );
    expect(result.status).not.toBe('done');
  });

  test('does not infer success from a failed interaction response', async () => {
    const result = await new FastDecisionEngine('heuristic_only').run(
      { goal: 'click Continue' },
      caller(
        () => ({ treeString: '[1] button "Continue"', tabUrl: 'https://example.test' }),
        () => ({ isError: true, content: [{ text: 'blocked' }] }),
      ),
    );
    expect(result.status).not.toBe('done');
  });

  test('disabled local decision mode never interacts', async () => {
    const calls: string[] = [];
    const result = await new FastDecisionEngine('disabled').run(
      { goal: 'click Continue' },
      async (tool: string) => {
        calls.push(tool);
        return {
          content: [
            {
              text: JSON.stringify({
                treeString: '[1] button "Continue"',
                tabUrl: 'https://example.test',
              }),
            },
          ],
        };
      },
    );
    expect(result.status).toBe('escalate');
    expect(calls).toEqual(['chrome_read_dom']);
  });

  test('masks sensitive values in every escalation field while retaining safe actionable context', async () => {
    const secrets = ['pass-secret', 'card-secret', 'cvc-secret', 'token-secret', 'label-secret'];
    const calls: string[] = [];
    const result = await new FastDecisionEngine('auto').run(
      { goal: 'buy Reports using pass-secret token-secret' },
      async (tool: string) => {
        calls.push(tool);
        return {
          content: [
            {
              text: JSON.stringify({
                treeString: [
                  '[1|e1] button "Reports"',
                  '[2|e2] link "Reports" href="https://example.test/?token=token-secret#card-secret"',
                  "[3|e3] textbox \\\"Password label-secret\\\" type='password' value='pass-secret'",
                  '[4|e4] textbox "Card" autocomplete="cc-number" value="card-secret"',
                  '[5|e5] textbox "CVC" data-sensitive="true" value="cvc-secret"',
                  ...Array.from(
                    { length: 130 },
                    (_, i) => `[${i + 6}|e${i + 6}] text "Noise ${i}"`,
                  ),
                ].join('\n'),
                tabUrl: 'https://example.test/private?token=token-secret#card-secret',
                tabTitle: 'Example',
              }),
            },
          ],
        };
      },
    );

    expect(result.status).toBe('escalate');
    const serialized = JSON.stringify(result);
    for (const secret of secrets) expect(serialized).not.toContain(secret);
    expect(result.currentElements).toContain('[1|e1] button "Reports"');
    expect(result.currentElements?.[1]).toMatch(/^\[2\|e2\] link "Reports" href=/);
    expect(result.currentElements?.length).toBeLessThanOrEqual(100);
    expect(result.cloudContext).toMatchObject({
      goal: expect.any(String),
      omittedElementCount: 35,
      requestFullDomWhenNeeded: true,
    });
  });

  test.each([
    [
      'password absent from DOM',
      { goal: 'type "pass-secret" into password field' },
      '[1|e1] textbox "Password" type="password"',
      'pass-secret',
    ],
    [
      'quoted typing payload',
      { goal: 'type "quoted-secret" into search field' },
      '[1|e1] textbox "Search"',
      'quoted-secret',
    ],
    [
      'URL fragment in page and result',
      { goal: 'click Reports' },
      '[1|e1] link "Reports" href="https://example.test/path#fragment-secret"',
      'fragment-secret',
    ],
    [
      'Bearer token in result',
      { goal: 'click Reports' },
      '[1|e1] text "Bearer bearer-secret"',
      'bearer-secret',
    ],
    [
      'sensitive JSON result fields',
      { goal: 'click Reports' },
      '[1|e1] text "safe"',
      'json-secret',
    ],
  ])('redacts %s on cloud escalation', async (_label, params, treeLine, secret) => {
    const result = await new FastDecisionEngine('disabled').run(params, async (tool: string) => ({
      content: [
        {
          text: JSON.stringify(
            tool === 'chrome_read_dom'
              ? {
                  treeString: treeLine,
                  tabUrl: `https://example.test/?session=session-secret#${secret}`,
                  title: 'safe',
                }
              : { isError: true, error: `Bearer ${secret}`, detail: { password: secret } },
          ),
        },
      ],
    }));
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain('session-secret');
  });

  test('keeps competing candidates and masks secret values in cloud escalation context', async () => {
    const result = await new FastDecisionEngine('auto').run(
      { goal: 'click Reports' },
      caller(() => ({
        treeString: [
          '[1|e1] button "Reports"',
          '[2|e2] link "Reports"',
          '[3|e3] textbox "Password" type="password" value="do-not-send"',
          ...Array.from({ length: 130 }, (_, i) => `[${i + 4}|e${i + 4}] text "Noise ${i}"`),
        ].join('\n'),
        tabUrl: 'https://example.test/private?token=secret',
        tabTitle: 'Example',
      })),
    );

    expect(result.status).toBe('escalate');
    expect(result.currentElements).toContain('[1|e1] button "Reports"');
    expect(result.currentElements).toContain('[2|e2] link "Reports"');
    expect(JSON.stringify(result.currentElements)).not.toContain('do-not-send');
    expect(JSON.stringify(result.currentElements)).not.toContain('token=secret');
    expect(result.currentElements?.length).toBeLessThanOrEqual(100);
    expect(result.cloudContext).toMatchObject({
      goal: 'click Reports',
      omittedElementCount: 33,
      requestFullDomWhenNeeded: true,
    });
  });

  test('does not retry a failed mutation within a bounded native task', async () => {
    const calls: string[] = [];
    const result = await new FastDecisionEngine('heuristic_only').run(
      { goal: 'click Continue', maxSteps: 5 },
      async (tool: string) => {
        calls.push(tool);
        if (tool === 'chrome_read_dom') {
          return {
            content: [
              {
                text: JSON.stringify({
                  treeString: '[1|e1] button "Continue"',
                  tabUrl: 'https://example.test',
                }),
              },
            ],
          };
        }
        return { isError: true, content: [{ text: JSON.stringify({ error: 'stale_ref' }) }] };
      },
    );

    expect(result.status).toBe('escalate');
    expect(calls.filter((name) => name === 'chrome_interact_index')).toHaveLength(1);
  });

  test('ambiguous duplicate names escalate without a click', async () => {
    const calls: string[] = [];
    const result = await new FastDecisionEngine('heuristic_only').run(
      { goal: 'click Reports' },
      async (tool: string) => {
        calls.push(tool);
        return {
          content: [
            {
              text: JSON.stringify({
                treeString: `[1] button "Reports"\n[2] link "Reports"`,
                tabUrl: 'https://example.test',
              }),
            },
          ],
        };
      },
    );
    expect(result.status).toBe('escalate');
    expect(calls).toEqual(['chrome_read_dom']);
  });
});
