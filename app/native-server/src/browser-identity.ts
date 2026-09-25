export type BrowserId = 'chrome' | 'edge';

export interface BrowserIdentity {
  browserId: BrowserId;
  port: 12306 | 12307;
}

export function resolveBrowserIdentity(value = process.env.WEBCLAW_BROWSER_ID): BrowserIdentity {
  const browserId = (value || 'chrome').toLowerCase();
  if (browserId !== 'chrome' && browserId !== 'edge') {
    throw new Error(`Invalid WEBCLAW_BROWSER_ID "${value}"; expected chrome or edge`);
  }
  return { browserId, port: browserId === 'edge' ? 12307 : 12306 };
}

export const BROWSER_IDENTITY = resolveBrowserIdentity();
