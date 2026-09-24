import { describe, it, expect } from 'vitest';
import {
  buildResult,
  postCondition,
} from '../entrypoints/background/tools/browser/result-envelope';

describe('result envelope', () => {
  it('marks a no-op as noop even when the call succeeded', () => {
    const r = buildResult({
      evidence: {
        urlChanged: false,
        previousUrl: 'u',
        currentUrl: 'u',
        delta: { changedNodes: 0 },
      },
      postConditions: [],
    });
    expect(r.verdict).toBe('noop');
    expect(r.outcome).toBe('no change detected');
  });
  it('never returns applied when a post-condition fails', () => {
    const r = buildResult({
      evidence: { committed: true, urlChanged: true, previousUrl: 'a', currentUrl: 'b' },
      postConditions: [postCondition('value_equals', 'Neo4j', 'Neo4jGraph')],
    });
    expect(r.verdict).toBe('failed');
    expect(r.postConditions[0]).toMatchObject({
      passed: false,
      expected: 'Neo4j',
      actual: 'Neo4jGraph',
    });
    expect(r.postConditions[0].evidence).toBeDefined();
  });
});

describe('applied_unverified verdict', () => {
  const CHANGED = {
    evidence: { committed: true, urlChanged: true, previousUrl: 'a', currentUrl: 'b' },
  } as const;

  it('changed with ZERO post-conditions is applied_unverified, not applied', () => {
    const r = buildResult({ evidence: { ...CHANGED.evidence }, postConditions: [] });
    expect(r.verdict).toBe('applied_unverified');
    expect(r.outcome).toBe('change detected, not verified by a post-condition');
    expect(r.postConditions).toEqual([]);
  });

  it('changed with one PASSING post-condition is applied', () => {
    const r = buildResult({
      evidence: { ...CHANGED.evidence },
      postConditions: [postCondition('value_equals', 'Neo4j', 'Neo4j')],
    });
    expect(r.postConditions[0].passed).toBe(true);
    expect(r.verdict).toBe('applied');
    expect(r.outcome).toBe('change detected');
  });

  it('changed with one FAILING post-condition is failed (unchanged)', () => {
    const r = buildResult({
      evidence: { ...CHANGED.evidence },
      postConditions: [postCondition('value_equals', 'Neo4j', 'Neo4jGraph')],
    });
    expect(r.verdict).toBe('failed');
    expect(r.outcome).toContain('value_equals failed');
  });

  it('unchanged is noop even with no post-conditions', () => {
    const r = buildResult({
      evidence: {
        urlChanged: false,
        previousUrl: 'u',
        currentUrl: 'u',
        delta: { changedNodes: 0 },
      },
      postConditions: [],
    });
    expect(r.verdict).toBe('noop');
    expect(r.outcome).toBe('no change detected');
  });

  it('a stale_ref recovery still wins over the change classification', () => {
    const r = buildResult({
      evidence: { ...CHANGED.evidence },
      postConditions: [],
      recovery: { code: 'stale_ref', message: '[3] is stale', freshRefs: [] },
    });
    expect(r.verdict).toBe('stale_ref');
    expect(r.outcome).toContain('stale ref');
  });
});
