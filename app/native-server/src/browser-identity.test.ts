import { resolveBrowserIdentity } from './browser-identity';

describe('resolveBrowserIdentity', () => {
  it('defaults to Chrome on port 12306', () => {
    expect(resolveBrowserIdentity(undefined)).toEqual({ browserId: 'chrome', port: 12306 });
  });
  it('resolves Edge to port 12307', () => {
    expect(resolveBrowserIdentity('edge')).toEqual({ browserId: 'edge', port: 12307 });
  });
  it('rejects unsupported browser identities', () => {
    expect(() => resolveBrowserIdentity('firefox')).toThrow(/WEBCLAW_BROWSER_ID/);
  });
});
