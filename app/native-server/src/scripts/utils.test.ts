import { BrowserType } from './browser-config';
import { createManifestContent } from './utils';
import { EXTENSION_ID } from './constant';

describe('createManifestContent allowed origins', () => {
  const originalChromeId = process.env.CHROME_EXTENSION_ID;
  const originalBrowserId = process.env.WEBCLAW_BROWSER_ID;
  afterEach(() => {
    if (originalChromeId === undefined) delete process.env.CHROME_EXTENSION_ID;
    else process.env.CHROME_EXTENSION_ID = originalChromeId;
    if (originalBrowserId === undefined) delete process.env.WEBCLAW_BROWSER_ID;
    else process.env.WEBCLAW_BROWSER_ID = originalBrowserId;
  });

  it('keeps both supported Chrome extension origins by default', async () => {
    delete process.env.CHROME_EXTENSION_ID;
    delete process.env.WEBCLAW_BROWSER_ID;
    const manifest = await createManifestContent();
    expect(manifest.allowed_origins).toEqual([
      `chrome-extension://${EXTENSION_ID}/`,
      'chrome-extension://biadnhhjlcaaopimoahhgcaipcbhafkf/',
    ]);
  });

  it('uses a validated explicitly configured id for a browser registration', async () => {
    process.env.CHROME_EXTENSION_ID = 'a'.repeat(32);
    const manifest = await createManifestContent(BrowserType.EDGE);
    expect(manifest.allowed_origins).toEqual([`chrome-extension://${'a'.repeat(32)}/`]);
  });

  it('rejects malformed configured extension ids', async () => {
    process.env.CHROME_EXTENSION_ID = 'not an extension id';
    await expect(createManifestContent(BrowserType.CHROME)).rejects.toThrow(/extension id/i);
  });
});
