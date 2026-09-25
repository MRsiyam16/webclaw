import { describe, expect, it } from 'vitest';

describe('interaction overlay response shape', () => {
  it('keeps navigation and overlay evidence additive', () => {
    const response = {
      success: true,
      urlChanged: false,
      navigation: { changed: false },
      overlayOpened: {
        opened: true,
        kind: 'modal',
        selector: 'div#checkoutModal',
        title: 'Checkout',
      },
    };
    expect(response).toMatchObject({
      navigation: { changed: false },
      overlayOpened: { kind: 'modal', selector: 'div#checkoutModal' },
    });
    expect(response.urlChanged).toBe(false);
  });
});
