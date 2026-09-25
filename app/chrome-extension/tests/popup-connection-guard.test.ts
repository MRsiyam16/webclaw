import { isPopupConnectionHealthy } from '../entrypoints/popup/connection-status';
import { describe, expect, it } from 'vitest';

describe('popup connection guard', () => {
  const matchingPing = { ok: true, status: 'ok', browserId: 'chrome', port: 12306 };

  it('reports connected only when the native port and running status agree with ping', () => {
    expect(
      isPopupConnectionHealthy(
        { success: true, connected: true, serverStatus: { isRunning: true, port: 12306 } },
        matchingPing,
        'chrome',
        12306,
      ),
    ).toBe(true);
  });

  it('reports disconnected when native connection is absent despite a matching healthy ping', () => {
    expect(
      isPopupConnectionHealthy(
        { success: true, connected: false, serverStatus: { isRunning: true, port: 12306 } },
        matchingPing,
        'chrome',
        12306,
      ),
    ).toBe(false);
  });
});
