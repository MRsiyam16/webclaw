import { describe, expect, it } from 'vitest';
import { extractFrom } from '../entrypoints/background/tools/browser/extract';

describe('B5 extract label fallback', () => {
  it('does not use a broad label container as a field value', () => {
    const out = extractFrom('<label>Population <div>India 1,400,000,000</div></label>', {
      type: 'object',
      properties: { population: { type: 'string' } },
    });
    expect(out.missing).toContain('population');
    expect(out.data).not.toHaveProperty('population');
  });
});
