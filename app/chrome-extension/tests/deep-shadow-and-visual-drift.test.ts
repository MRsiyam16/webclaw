import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  inPageDOMPruner,
  renderCompactElementLine,
  querySelectorAllDeep,
  querySelectorDeep,
  splitSelectorSafely,
  splitByCharacterUnlessQuoted,
  parentElementOrShadowHost,
  composedContains,
  composedParent,
  extractCleanElementText,
  inPageSnapCoordinate,
  inPageGetScrollState,
  inPageInstantScrollTo,
  inPageLockScroll,
  deepElementFromPoint,
  inPageExtractDeepPageText,
} from '../entrypoints/background/tools/browser/dom-indexer';
import { screenshotContextManager, scaleCoordinates } from '../utils/screenshot-context';
import { grepTool, extractContextualSnippet } from '../entrypoints/background/tools/browser/grep';

describe('Deep Shadow DOM Piercing & Visual Drift Compensation', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  describe('1. Shreddit Multi-Layer Web Component Shadow DOM Piercing', () => {
    it('penetrates multi-nested shadow roots and retains icon buttons with aria-label', () => {
      // Simulate Reddit Shreddit Web Components structure
      const comment = document.createElement('shreddit-comment');
      comment.id = 'comment-t1_123';
      document.body.appendChild(comment);

      const commentShadow = comment.attachShadow({ mode: 'open' });
      const tracker = document.createElement('faceplate-tracker');
      tracker.setAttribute('action', 'reply');
      commentShadow.appendChild(tracker);

      const trackerShadow = tracker.attachShadow({ mode: 'open' });
      const replyBtn = document.createElement('button');
      replyBtn.setAttribute('aria-label', 'Reply');
      replyBtn.id = 'reply-action-btn';

      // Icon only, no textContent
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      replyBtn.appendChild(svg);
      trackerShadow.appendChild(replyBtn);

      // Verify text extractor gets semantic label
      const extractedText = extractCleanElementText(replyBtn);
      expect(extractedText).toBe('Reply');

      // Verify querySelectorAllDeep finds nested button across both shadow boundaries
      const foundButtons = querySelectorAllDeep('button', document);
      expect(foundButtons).toContain(replyBtn);

      const foundByAria = querySelectorAllDeep('[aria-label="Reply"]', document);
      expect(foundByAria).toContain(replyBtn);

      // Verify inPageDOMPruner indexes the button with [shadow] tag
      // Mock getBoundingClientRect
      Object.defineProperty(replyBtn, 'getBoundingClientRect', {
        value: () => ({
          left: 40,
          top: 120,
          right: 100,
          bottom: 150,
          width: 60,
          height: 30,
          x: 40,
          y: 120,
        }),
      });

      const res = inPageDOMPruner();
      const indexedBtn = res.indexedElements.find(
        (el) => el.attributes?.id === 'reply-action-btn' || el.text === 'Reply',
      );
      expect(indexedBtn).toBeDefined();
      expect(indexedBtn?.inShadowDom).toBe(true);

      const line = renderCompactElementLine(indexedBtn!);
      expect(line).toContain('[shadow]');
      expect(line).toContain('button "Reply"');
    });

    it('finds elements via querySelectorDeep and querySelectorAllDeep across shadow roots', () => {
      const host = document.createElement('custom-card');
      document.body.appendChild(host);
      const shadow = host.attachShadow({ mode: 'open' });

      const innerDiv = document.createElement('div');
      innerDiv.className = 'card-content';
      const innerLink = document.createElement('a');
      innerLink.href = 'https://example.com/item';
      innerLink.textContent = 'View Details';
      innerDiv.appendChild(innerLink);
      shadow.appendChild(innerDiv);

      const match = querySelectorDeep('.card-content a', document);
      expect(match).toBe(innerLink);

      const allLinks = querySelectorAllDeep('a', document);
      expect(allLinks).toContain(innerLink);
    });

    it('correctly determines composed ancestry through multiple nested shadow roots', () => {
      const outer = document.createElement('outer-comp');
      document.body.appendChild(outer);
      const outerShadow = outer.attachShadow({ mode: 'open' });

      const inner = document.createElement('inner-comp');
      outerShadow.appendChild(inner);
      const innerShadow = inner.attachShadow({ mode: 'open' });

      const leaf = document.createElement('span');
      leaf.textContent = 'Nested Leaf';
      innerShadow.appendChild(leaf);

      expect(composedContains(outer, leaf)).toBe(true);
      expect(composedContains(inner, leaf)).toBe(true);
      expect(composedParent(leaf)).toBe(inner);
      expect(composedParent(inner)).toBe(outer);
    });

    it('penetrates multi-level nested shadow roots using deepElementFromPoint', () => {
      const outerHost = document.createElement('outer-widget');
      document.body.appendChild(outerHost);
      const outerShadow = outerHost.attachShadow({ mode: 'open' });

      const innerHost = document.createElement('inner-widget');
      outerShadow.appendChild(innerHost);
      const innerShadow = innerHost.attachShadow({ mode: 'open' });

      const targetBtn = document.createElement('button');
      targetBtn.id = 'deep-target-btn';
      innerShadow.appendChild(targetBtn);

      document.elementFromPoint = vi.fn().mockReturnValue(outerHost);
      (outerShadow as any).elementFromPoint = vi.fn().mockReturnValue(innerHost);
      (innerShadow as any).elementFromPoint = vi.fn().mockReturnValue(targetBtn);

      const resolved = deepElementFromPoint(150, 250, document);
      expect(resolved).toBe(targetBtn);
    });

    it('traverses and indexes interactive elements inside pointer-events: none containers', () => {
      const container = document.createElement('div');
      container.style.pointerEvents = 'none';
      document.body.appendChild(container);

      const button = document.createElement('button');
      button.id = 'active-inside-none-container';
      button.textContent = 'Active Action';
      button.style.pointerEvents = 'auto';
      container.appendChild(button);

      Object.defineProperty(button, 'getBoundingClientRect', {
        value: () => ({
          left: 50,
          top: 50,
          right: 150,
          bottom: 80,
          width: 100,
          height: 30,
          x: 50,
          y: 50,
        }),
      });

      const res = inPageDOMPruner();
      const indexed = res.indexedElements.find(
        (el) => el.attributes?.id === 'active-inside-none-container',
      );
      expect(indexed).toBeDefined();
      expect(indexed?.text).toBe('Active Action');
    });
  });

  describe('2. Closed Shadow Host Detection', () => {
    it('detects custom element with closed/null shadowRoot as closed shadow host if interactive', () => {
      const closedHost = document.createElement('closed-widget');
      closedHost.setAttribute('aria-label', 'Closed Widget Trigger');
      closedHost.tabIndex = 0;
      document.body.appendChild(closedHost);

      Object.defineProperty(closedHost, 'getBoundingClientRect', {
        value: () => ({
          left: 10,
          top: 10,
          right: 110,
          bottom: 50,
          width: 100,
          height: 40,
          x: 10,
          y: 10,
        }),
      });

      const res = inPageDOMPruner();
      const hostElem = res.indexedElements.find((el) => el.tagName === 'closed-widget');
      expect(hostElem).toBeDefined();
      expect(hostElem?.inShadowDom).toBe(true);
      expect(hostElem?.isClosedShadowHost).toBe(true);

      const compactLine = renderCompactElementLine(hostElem!);
      expect(compactLine).toContain('[closed-shadow-host]');
    });

    it('marks closed shadow host on interactive custom element with data-action', () => {
      const formHost = document.createElement('faceplate-form');
      formHost.setAttribute('data-action', 'submit');
      formHost.tabIndex = 0;
      document.body.appendChild(formHost);

      Object.defineProperty(formHost, 'getBoundingClientRect', {
        value: () => ({
          left: 10,
          top: 10,
          right: 110,
          bottom: 50,
          width: 100,
          height: 40,
          x: 10,
          y: 10,
        }),
      });

      const res = inPageDOMPruner();
      const hostElem = res.indexedElements.find((el) => el.tagName === 'faceplate-form');
      expect(hostElem).toBeDefined();
      expect(hostElem?.isClosedShadowHost).toBe(true);

      const line = renderCompactElementLine(hostElem!);
      expect(line).toContain('[closed-shadow-host]');
    });
  });

  describe('3. Deep Text Extraction in chrome_grep', () => {
    it('extracts deep text inside shadow DOM roots for page_text and interactive search', async () => {
      const host = document.createElement('reddit-thread');
      document.body.appendChild(host);
      const shadow = host.attachShadow({ mode: 'open' });

      const upvoteBtn = document.createElement('button');
      upvoteBtn.setAttribute('aria-label', 'Upvote 42');
      shadow.appendChild(upvoteBtn);

      Object.defineProperty(upvoteBtn, 'getBoundingClientRect', {
        value: () => ({
          left: 20,
          top: 20,
          right: 60,
          bottom: 50,
          width: 40,
          height: 30,
          x: 20,
          y: 20,
        }),
      });

      const prunerRes = inPageDOMPruner();
      expect(
        prunerRes.indexedElements.some((e) => e.attributes?.['aria-label'] === 'Upvote 42'),
      ).toBe(true);
    });

    it('extracts deep page text with slots, shadow roots, and accessible names using inPageExtractDeepPageText', () => {
      const host = document.createElement('shreddit-post');
      document.body.appendChild(host);

      const title = document.createElement('h1');
      title.textContent = 'Main Post Title';
      host.appendChild(title);

      const shadow = host.attachShadow({ mode: 'open' });
      const shadowPara = document.createElement('p');
      shadowPara.textContent = 'Shadow comment text';
      shadow.appendChild(shadowPara);

      const upvote = document.createElement('button');
      upvote.setAttribute('aria-label', 'Upvote Post');
      shadow.appendChild(upvote);

      const deepText = inPageExtractDeepPageText(host);
      expect(deepText).toContain('Main Post Title');
      expect(deepText).toContain('Shadow comment text');
      expect(deepText).toContain('[Upvote Post]');
    });

    it('formats centered contextual snippets with extractContextualSnippet', () => {
      const shortLine = 'This is a short line with target query';
      const pat = /target query/i;
      expect(extractContextualSnippet(shortLine, pat)).toBe(shortLine);

      const prefix = 'A'.repeat(80);
      const suffix = 'B'.repeat(80);
      const longLine = `${prefix} KEYWORD ${suffix}`;
      const pat2 = /KEYWORD/i;
      const snippet = extractContextualSnippet(longLine, pat2);
      expect(snippet).toContain('KEYWORD');
      expect(snippet.startsWith('...')).toBe(true);
      expect(snippet.endsWith('...')).toBe(true);
      expect(snippet.length).toBeLessThan(120);
    });

    it('performs automatic deep page text fallback in chrome_grep when interactive matches is 0', async () => {
      const engine = await import('../entrypoints/background/tools/browser/in-page-engine');
      const spy = vi.spyOn(engine, 'executeInPage');
      vi.spyOn(grepTool as any, 'resolveAffinityTab').mockResolvedValue({
        id: 42,
        url: 'https://reddit.com',
      });

      spy.mockImplementation(async (target: any, fnName: string, args: any) => {
        if (fnName === 'inPageDOMPruner') {
          return [
            {
              frameId: 0,
              result: {
                elementCount: 0,
                interactiveCount: 0,
                indexedElements: [],
                indexMap: {},
              },
            },
          ] as any;
        }
        if (fnName === 'inPageExtractDeepPageText') {
          return [
            {
              frameId: 0,
              result:
                'First paragraph\nDeep shadow article content mentioning ShredditArchitecture\nThird paragraph',
            },
          ] as any;
        }
        return [] as any;
      });

      const res = await grepTool.execute({
        query: 'ShredditArchitecture',
        searchType: 'interactive_only',
      });
      expect(res.isError).toBe(false);
      const parsed = JSON.parse(res.content[0].text);
      expect(parsed.totalMatches).toBe(1);
      expect(parsed.matches[0].text).toContain('ShredditArchitecture');
      expect(parsed.fallbackUsed).toBe(true);
      expect(parsed.scanScope).toBe('page_text');
      expect(parsed.note).toBeUndefined();

      spy.mockRestore();
    });

    it('greps interactive elements by data-testid, data-action, aria-description, and data-click-id', async () => {
      const engine = await import('../entrypoints/background/tools/browser/in-page-engine');
      const spy = vi.spyOn(engine, 'executeInPage');
      vi.spyOn(grepTool as any, 'resolveAffinityTab').mockResolvedValue({
        id: 42,
        url: 'https://reddit.com',
      });

      spy.mockImplementation(async (target: any, fnName: string, args: any) => {
        if (fnName === 'inPageDOMPruner') {
          return [
            {
              frameId: 0,
              result: {
                elementCount: 4,
                interactiveCount: 4,
                indexedElements: [
                  {
                    index: 1,
                    tagName: 'button',
                    role: 'button',
                    isInteractive: true,
                    attributes: { 'data-testid': 'comment-reply-button' },
                  },
                  {
                    index: 2,
                    tagName: 'button',
                    role: 'button',
                    isInteractive: true,
                    attributes: { 'data-action': 'upvote' },
                  },
                  {
                    index: 3,
                    tagName: 'div',
                    role: 'button',
                    isInteractive: true,
                    attributes: { 'aria-description': 'award-gold-star' },
                  },
                  {
                    index: 4,
                    tagName: 'a',
                    role: 'link',
                    isInteractive: true,
                    attributes: { 'data-click-id': 'timestamp-link' },
                  },
                ],
                indexMap: {
                  1: { selector: '#btn1', tagName: 'button' },
                  2: { selector: '#btn2', tagName: 'button' },
                  3: { selector: '#div3', tagName: 'div' },
                  4: { selector: '#a4', tagName: 'a' },
                },
              },
            },
          ] as any;
        }
        return [] as any;
      });

      const resTestId = await grepTool.execute({ query: 'comment-reply-button' });
      expect(JSON.parse(resTestId.content[0].text).totalMatches).toBe(1);

      const resAction = await grepTool.execute({ query: 'upvote' });
      expect(JSON.parse(resAction.content[0].text).totalMatches).toBe(1);

      const resDesc = await grepTool.execute({ query: 'award-gold-star' });
      expect(JSON.parse(resDesc.content[0].text).totalMatches).toBe(1);

      const resClickId = await grepTool.execute({ query: 'timestamp-link' });
      expect(JSON.parse(resClickId.content[0].text).totalMatches).toBe(1);

      spy.mockRestore();
    });
  });

  describe('4. Visual Fallback Coordinate Alignment & Drift Elimination', () => {
    it('scales fullpage coordinates in document space without collapsing to viewport', () => {
      const ctx = {
        screenshotWidth: 1200,
        screenshotHeight: 3600,
        viewportWidth: 1200,
        viewportHeight: 800,
        captureMode: 'fullpage' as const,
        docWidth: 1200,
        docHeight: 3600,
        timestamp: Date.now(),
      };

      const scaled = scaleCoordinates(600, 1800, ctx);
      expect(scaled.isDocumentSpace).toBe(true);
      expect(scaled.x).toBe(600);
      expect(scaled.y).toBe(1800); // Stays at 1800 in doc space instead of compressing to (1800/3600)*800 = 400!
    });

    it('tracks and retrieves real-time scroll state and provides instant scrolling', () => {
      const state = inPageGetScrollState();
      expect(state).toHaveProperty('scrollX');
      expect(state).toHaveProperty('scrollY');
      expect(state).toHaveProperty('viewportWidth');
      expect(state).toHaveProperty('viewportHeight');

      const scrollRes = inPageInstantScrollTo(0, 300);
      expect(scrollRes.success).toBe(true);
    });

    it('locks and restores scroll behavior to prevent race conditions during click injection', () => {
      document.documentElement.style.scrollBehavior = 'smooth';
      inPageLockScroll(true);
      expect(document.documentElement.style.scrollBehavior).toBe('auto');

      inPageLockScroll(false);
      expect(document.documentElement.style.scrollBehavior).toBe('smooth');
    });

    it('snaps coordinates to interactive shadow DOM buttons when clicking near them', () => {
      const host = document.createElement('reddit-comment');
      document.body.appendChild(host);
      const shadow = host.attachShadow({ mode: 'open' });

      const replyBtn = document.createElement('button');
      replyBtn.setAttribute('aria-label', 'Reply');
      shadow.appendChild(replyBtn);

      Object.defineProperty(replyBtn, 'getBoundingClientRect', {
        value: () => ({
          left: 100,
          top: 200,
          right: 150,
          bottom: 230,
          width: 50,
          height: 30,
          x: 100,
          y: 200,
        }),
      });

      // Click slightly outside (e.g. at 155, 215)
      const snap = inPageSnapCoordinate(155, 215, 24);
      expect(snap.snapped).toBe(true);
      expect(snap.x).toBe(125); // Midpoint between 100 and 150
      expect(snap.y).toBe(215); // Midpoint between 200 and 230
    });

    it('snaps coordinates and centers element if snapped target is offscreen', () => {
      const host = document.createElement('reddit-comment');
      document.body.appendChild(host);
      const shadow = host.attachShadow({ mode: 'open' });

      const replyBtn = document.createElement('button');
      replyBtn.setAttribute('aria-label', 'Reply');
      shadow.appendChild(replyBtn);

      let scrolledIntoView = false;
      replyBtn.scrollIntoView = vi.fn().mockImplementation(() => {
        scrolledIntoView = true;
      });

      // Target is clipped at viewport bottom (bottom > innerHeight of 768)
      Object.defineProperty(replyBtn, 'getBoundingClientRect', {
        value: () => ({
          left: 100,
          top: 740,
          right: 180,
          bottom: 790,
          width: 80,
          height: 50,
          x: 100,
          y: 740,
        }),
      });

      const snap = inPageSnapCoordinate(110, 750, 24);
      expect(snap.snapped).toBe(true);
      expect(scrolledIntoView).toBe(true);
    });
    describe('6. Cross-Root Composite Selector Engine (Shadow DOM Piercing)', () => {
      it('safely splits selectors without breaking spaces in single or double quoted attributes', () => {
        const tokens1 = splitSelectorSafely('textarea[placeholder="Body text*"]');
        expect(tokens1).toEqual(['textarea[placeholder="Body text*"]']);

        const tokens2 = splitSelectorSafely("textarea[placeholder='Body text*']");
        expect(tokens2).toEqual(["textarea[placeholder='Body text*']"]);

        const tokens3 = splitSelectorSafely('shreddit-markdown-composer textarea');
        expect(tokens3).toEqual(['shreddit-markdown-composer', 'textarea']);

        const tokens4 = splitSelectorSafely('shreddit-markdown-composer >> textarea');
        expect(tokens4).toEqual(['shreddit-markdown-composer', 'textarea']);

        const tokens5 = splitSelectorSafely('shreddit-markdown-composer >>> textarea');
        expect(tokens5).toEqual(['shreddit-markdown-composer', 'textarea']);

        const tokens6 = splitSelectorSafely('shreddit-markdown-composer /deep/ textarea');
        expect(tokens6).toEqual(['shreddit-markdown-composer', 'textarea']);

        const tokens7 = splitSelectorSafely('div > span + p ~ a');
        expect(tokens7).toEqual(['div>span+p~a']);
      });

      it('pierces shadow boundaries to match textarea[placeholder="Body text*"] inside shadow DOM', () => {
        const host = document.createElement('custom-editor');
        document.body.appendChild(host);

        const shadow = host.attachShadow({ mode: 'open' });
        const textarea = document.createElement('textarea');
        textarea.setAttribute('placeholder', 'Body text*');
        shadow.appendChild(textarea);

        const found = querySelectorDeep('textarea[placeholder="Body text*"]', document);
        expect(found).toBe(textarea);
      });

      it('matches cross-shadow composite selector shreddit-markdown-composer textarea', () => {
        const composer = document.createElement('shreddit-markdown-composer');
        document.body.appendChild(composer);

        const shadow = composer.attachShadow({ mode: 'open' });
        const innerDiv = document.createElement('div');
        const textarea = document.createElement('textarea');
        textarea.id = 'post-content-textarea';
        innerDiv.appendChild(textarea);
        shadow.appendChild(innerDiv);

        // 1. Descendant space piercing
        const matchedBySpace = querySelectorDeep('shreddit-markdown-composer textarea', document);
        expect(matchedBySpace).toBe(textarea);

        // 2. Playwright >> piercing
        const matchedByPlaywright = querySelectorDeep(
          'shreddit-markdown-composer >> textarea',
          document,
        );
        expect(matchedByPlaywright).toBe(textarea);

        // 3. Shadow combinator >>> piercing
        const matchedByTriple = querySelectorDeep(
          'shreddit-markdown-composer >>> textarea',
          document,
        );
        expect(matchedByTriple).toBe(textarea);

        // 4. /deep/ piercing
        const matchedByDeep = querySelectorDeep(
          'shreddit-markdown-composer /deep/ textarea',
          document,
        );
        expect(matchedByDeep).toBe(textarea);
      });

      it('finds parent element or shadow host across shadow boundaries using parentElementOrShadowHost', () => {
        const host = document.createElement('my-host-element');
        document.body.appendChild(host);

        const shadow = host.attachShadow({ mode: 'open' });
        const innerChild = document.createElement('span');
        shadow.appendChild(innerChild);

        expect(parentElementOrShadowHost(innerChild)).toBe(host);
        expect(parentElementOrShadowHost(host)).toBe(document.body);
      });
    });
  });
});
