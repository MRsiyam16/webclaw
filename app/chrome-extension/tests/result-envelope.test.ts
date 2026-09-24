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
