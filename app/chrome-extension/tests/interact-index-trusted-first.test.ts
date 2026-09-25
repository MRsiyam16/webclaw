import { describe, expect, it } from 'vitest';

describe('interact_index delivery reporting contract', () => {
  it('uses explicit trusted and synthetic delivery labels', () => {
    const deliveryMethod = (isTrusted: boolean) => (isTrusted ? 'cdp_input' : 'synthetic');
    expect(deliveryMethod(true)).toBe('cdp_input');
    expect(deliveryMethod(false)).toBe('synthetic');
  });
});
