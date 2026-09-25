import { describe, expect, it } from 'vitest';
import { resolveBatchRefAlias } from '../entrypoints/background/tools/browser/batch-actions';

describe('batch mid-batch refs', () => {
  const refs = new Map([['control', { ref: 'e42', documentToken: 1234 }]]);

  it('resolves an extracted alias after a same-document state transition', () => {
    expect(resolveBatchRefAlias('control', refs, 1234)).toEqual({ ref: 'e42' });
  });

  it('returns stale_ref after navigation to a different document', () => {
    expect(resolveBatchRefAlias('control', refs, 5678)).toEqual({
      verdict: 'stale_ref',
      ref: 'e42',
    });
  });

  it('fails closed when the current document identity cannot be read', () => {
    expect(resolveBatchRefAlias('control', refs, undefined)).toEqual({
      verdict: 'stale_ref',
      ref: 'e42',
    });
  });

  it('leaves ordinary refs and unknown aliases untouched', () => {
    expect(resolveBatchRefAlias('e7', refs, 1234)).toBeUndefined();
  });
});
