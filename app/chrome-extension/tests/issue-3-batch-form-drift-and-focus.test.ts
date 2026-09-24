import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  inPageVerifyActiveElement,
  inPageVerifyInputCommitment,
  inPageSelectCustomCombobox,
  getIsolatedIndexMap,
} from '../entrypoints/background/tools/browser/dom-indexer';
import * as fillCore from '../entrypoints/background/tools/browser/fill-core';
import * as engine from '../entrypoints/background/tools/browser/in-page-engine';
import { readDOMTool } from '../entrypoints/background/tools/browser/read-dom';
import { batchActionsTool } from '../entrypoints/background/tools/browser/batch-actions';
import { cdpSessionManager } from '@/utils/cdp-session-manager';
import * as fs from 'fs';
import * as path from 'path';

describe('GitHub Issue #3: Dynamic Index Drift, Active Element Focus Guard & Anti-Concatenation', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    getIsolatedIndexMap().clear();
    vi.clearAllMocks();
  });

  describe('1. Active Element Focus Guard (inPageVerifyActiveElement & performPhysicalFill)', () => {
    it('returns isFocused: true when document.activeElement matches the target element', () => {
      const input = document.createElement('input');
      input.id = 'first-name';
      document.body.appendChild(input);
      input.focus();

      getIsolatedIndexMap().set(1, input);

      const res = inPageVerifyActiveElement(1);
      expect(res.success).toBe(true);
      expect(res.isFocused).toBe(true);
      expect(res.targetTag).toBe('input');
      expect(res.activeId).toBe('first-name');
    });

    it('returns isFocused: false with descriptive error when target is not focused and focus cannot be acquired', () => {
      const input1 = document.createElement('input');
      input1.id = 'first-name';
      const input2 = document.createElement('input');
      input2.id = 'last-name';

      document.body.appendChild(input1);
      document.body.appendChild(input2);

      // Previous input is currently focused
      input1.focus();

      // Prevent programmatic focus on input2
      input2.focus = vi.fn();

      getIsolatedIndexMap().set(1, input1);
      getIsolatedIndexMap().set(2, input2);

      const res = inPageVerifyActiveElement(2);
      expect(res.success).toBe(false);
      expect(res.isFocused).toBe(false);
      expect(res.activeId).toBe('first-name');
      expect(res.error).toContain('Focus verification failed: target element [2]');
      expect(res.error).toContain('document.activeElement is <input#first-name>');
    });

    it('resolves active element nested inside shadow root', () => {
      const host = document.createElement('div');
      const shadowRoot = host.attachShadow({ mode: 'open' });
      const shadowInput = document.createElement('input');
      shadowInput.id = 'shadow-field';
      shadowRoot.appendChild(shadowInput);
      document.body.appendChild(host);

      shadowInput.focus();

      getIsolatedIndexMap().set(10, shadowInput);

      const res = inPageVerifyActiveElement(10);
      expect(res.success).toBe(true);
      expect(res.isFocused).toBe(true);
    });

    it('performPhysicalFill aborts with FocusVerificationError when focus verification fails', async () => {
      vi.spyOn(engine, 'executeInPage').mockImplementation(async (_target, fnName) => {
        if (fnName === 'inPageGetElementCoordinates') {
          return [{ result: { success: true, x: 100, y: 100, tagName: 'input' } }] as any;
        }
        if (fnName === 'inPageVerifyActiveElement') {
          return [
            {
              result: {
                success: false,
                isFocused: false,
                targetTag: 'input',
                activeTag: 'input',
                activeId: 'prev-field',
                error:
                  'Focus verification failed: target element [2] (<input>) is not active. document.activeElement is <input#prev-field>. Target element could not be focused.',
              },
            },
          ] as any;
        }
        return [{ result: { success: true } }] as any;
      });

      vi.spyOn(cdpSessionManager, 'withSession').mockImplementation(async (_tabId, _tag, fn) =>
        fn(),
      );
      vi.spyOn(cdpSessionManager, 'sendCommand').mockResolvedValue({});

      const result = await fillCore.performPhysicalFill({
        tabId: 1,
        target: 2,
        text: 'Smith',
      });

      expect(result.success).toBe(false);
      expect(result.committed).toBe(false);
      expect(result.error).toContain('Focus verification failed');
      expect(result.error).toContain('document.activeElement is <input#prev-field>');
    });
  });

  describe('2. Strict Input Commitment Verification (Anti-Concatenation)', () => {
    it('strictly verifies exact match as committed', () => {
      const input = document.createElement('input');
      input.value = 'Jane';
      document.body.appendChild(input);

      getIsolatedIndexMap().set(1, input);

      const verified = inPageVerifyInputCommitment(1, 'Jane');
      expect(verified.committed).toBe(true);
      expect(verified.currentValue).toBe('Jane');
    });

    it('rejects concatenated values where previous field text is merged into current field', () => {
      const input = document.createElement('input');
      // Previous buggy behavior passed 'JohnJane' because 'JohnJane'.includes('Jane') was true!
      input.value = 'JohnJane';
      document.body.appendChild(input);

      getIsolatedIndexMap().set(1, input);

      const verified = inPageVerifyInputCommitment(1, 'Jane');
      expect(verified.committed).toBe(false);
      expect(verified.currentValue).toBe('JohnJane');
      expect(verified.diagnostics).toContain('JohnJane');
      expect(verified.diagnostics).toContain('Jane');
    });

    it('respects maxLength truncation constraint strictly', () => {
      const input = document.createElement('input');
      input.maxLength = 4;
      input.value = '1234';
      document.body.appendChild(input);

      getIsolatedIndexMap().set(2, input);

      // Expected is longer than maxLength, but input capped strictly at maxLength
      const verified = inPageVerifyInputCommitment(2, '123456');
      expect(verified.committed).toBe(true);
      expect(verified.currentValue).toBe('1234');
    });

    it('rejects when current value is empty and expected value is non-empty', () => {
      const input = document.createElement('input');
      input.value = '';
      document.body.appendChild(input);

      getIsolatedIndexMap().set(3, input);

      const verified = inPageVerifyInputCommitment(3, 'Required Value');
      expect(verified.committed).toBe(false);
    });

    it('accepts clean formatted phone number while rejecting concatenated inputs', () => {
      const phoneInput = document.createElement('input');
      phoneInput.type = 'tel';
      phoneInput.name = 'phone_number';
      // Reactive form formatted raw digits into (555) 123-4567
      phoneInput.value = '(555) 123-4567';
      document.body.appendChild(phoneInput);

      getIsolatedIndexMap().set(4, phoneInput);

      // Clean replacement: raw digits match formatted phone input
      const verified = inPageVerifyInputCommitment(4, '5551234567');
      expect(verified.committed).toBe(true);

      // Concatenation: two phone numbers merged
      phoneInput.value = '55512345679998887777';
      const concatVerified = inPageVerifyInputCommitment(4, '9998887777');
      expect(concatVerified.committed).toBe(false);
    });

    it('accepts static currency/symbol prefix while rejecting multi-field concatenation', () => {
      const priceInput = document.createElement('input');
      priceInput.value = '$ 250.00';
      document.body.appendChild(priceInput);

      getIsolatedIndexMap().set(5, priceInput);

      const verified = inPageVerifyInputCommitment(5, '250.00');
      expect(verified.committed).toBe(true);

      // Multi-field concatenation must be rejected
      priceInput.value = 'username@test.com250.00';
      const concatVerified = inPageVerifyInputCommitment(5, '250.00');
      expect(concatVerified.committed).toBe(false);
    });
  });

  describe('3. Custom Combobox & Listbox Selection (inPageSelectCustomCombobox)', () => {
    it('opens closed combobox and selects option by matching text', async () => {
      const combo = document.createElement('div');
      combo.setAttribute('role', 'combobox');
      combo.setAttribute('aria-expanded', 'false');
      combo.setAttribute('aria-controls', 'month-list');

      const listbox = document.createElement('ul');
      listbox.id = 'month-list';
      listbox.setAttribute('role', 'listbox');

      const opt1 = document.createElement('li');
      opt1.setAttribute('role', 'option');
      opt1.textContent = 'January';

      const opt2 = document.createElement('li');
      opt2.setAttribute('role', 'option');
      opt2.textContent = 'February';

      listbox.appendChild(opt1);
      listbox.appendChild(opt2);

      document.body.appendChild(combo);
      document.body.appendChild(listbox);

      getIsolatedIndexMap().set(5, combo);

      let optionClicked = false;
      opt2.addEventListener('click', () => {
        optionClicked = true;
        combo.setAttribute('aria-valuenow', 'February');
      });

      const res = await inPageSelectCustomCombobox(5, undefined, 'February');
      expect(res.success).toBe(true);
      expect(res.committed).toBe(true);
      expect(res.selectedText).toBe('February');
      expect(optionClicked).toBe(true);
    });

    it('selects option using word boundary matching to avoid substring collision (e.g. Day 1 vs Day 10)', async () => {
      const combo = document.createElement('div');
      combo.setAttribute('role', 'combobox');
      combo.setAttribute('aria-expanded', 'true');
      combo.setAttribute('aria-controls', 'day-list');

      const listbox = document.createElement('ul');
      listbox.id = 'day-list';
      listbox.setAttribute('role', 'listbox');

      const opt10 = document.createElement('li');
      opt10.setAttribute('role', 'option');
      opt10.textContent = 'Day 10';

      const opt1 = document.createElement('li');
      opt1.setAttribute('role', 'option');
      opt1.textContent = 'Day 1';

      listbox.appendChild(opt10);
      listbox.appendChild(opt1);

      document.body.appendChild(combo);
      document.body.appendChild(listbox);

      getIsolatedIndexMap().set(7, combo);

      const res = await inPageSelectCustomCombobox(7, undefined, '1');
      expect(res.success).toBe(true);
      expect(res.selectedText).toBe('Day 1');
    });

    it('verifies custom combobox commitment via inPageVerifyInputCommitment', () => {
      const combo = document.createElement('div');
      combo.setAttribute('role', 'combobox');
      combo.setAttribute('aria-valuenow', 'March');
      document.body.appendChild(combo);

      getIsolatedIndexMap().set(6, combo);

      const verified = inPageVerifyInputCommitment(6, 'March');
      expect(verified.committed).toBe(true);
      expect(verified.currentValue).toBe('March');
    });

    it('reads the element own value when the combobox control IS the <input> itself (Wikipedia Codex typeahead)', () => {
      // Real-world shape: <input type="search" role="combobox" aria-expanded="true" value="Neo4j">
      // The element has no <input> child and no textContent, so the combobox branch must
      // fall back to the element's own .value or a successful fill is reported as a mismatch.
      const input = document.createElement('input');
      input.type = 'search';
      input.setAttribute('role', 'combobox');
      input.setAttribute('aria-expanded', 'true');
      input.value = 'Neo4j';
      document.body.appendChild(input);

      getIsolatedIndexMap().set(9, input);

      const verified = inPageVerifyInputCommitment(9, 'Neo4j');
      expect(verified.committed).toBe(true);
      expect(verified.currentValue).toBe('Neo4j');
      expect(verified.diagnostics).toBeUndefined();

      // A genuinely wrong value must STILL be diagnosed
      input.value = 'Cypher';
      const mismatch = inPageVerifyInputCommitment(9, 'Neo4j');
      expect(mismatch.committed).toBe(false);
      expect(mismatch.currentValue).toBe('Cypher');
      expect(mismatch.diagnostics).toContain('did not match expected');
    });
  });

  describe('4. Scope Scrutiny in read_dom for form selector', () => {
    it('provides diagnostic suggestion when selector "form" finds 0 elements on div-based page', async () => {
      (globalThis as any).chrome = {
        tabs: {
          get: vi.fn().mockResolvedValue({ id: 10, url: 'https://example.com/reg' }),
        },
      };

      vi.spyOn(engine, 'executeInPage').mockResolvedValue([
        {
          frameId: 0,
          result: {
            elementCount: 0,
            indexedElements: [],
            selectorMatched: false,
          },
        },
      ] as any);

      const res = await readDOMTool.execute({
        tabId: 10,
        selector: 'form',
      });

      expect(res.isError).toBe(false);
      const text = res.content[0].text;
      const data = JSON.parse(text);

      expect(data.selectorMatched).toBe(false);
      expect(data.message).toContain('No elements matching selector "form" found on page');
      expect(data.suggestion).toContain(
        'Modern div-based SPAs often do not use native <form> tags. Try targeting \'[role="form"]\'',
      );
      expect(data.diagnostic).toContain('Selector "form" matched 0 elements');
    });
  });

  describe('5. Hermes Plugin SKILL.md and Config Tool Names Alignment', () => {
    it('confirms plugins/browserclaw/skills/browserclaw/SKILL.md has 0 chrome_* references', () => {
      const skillMdPath = path.resolve(
        __dirname,
        '../../../plugins/browserclaw/skills/browserclaw/SKILL.md',
      );
      if (fs.existsSync(skillMdPath)) {
        const content = fs.readFileSync(skillMdPath, 'utf-8');
        const chromeMatches = content.match(/\bchrome_[a-z_]+/g) || [];
        expect(chromeMatches).toEqual([]);
        expect(content).toContain('browserclaw_read_dom');
        expect(content).toContain('browserclaw_fill_index');
      }
    });

    it('confirms plugins/browserclaw/skills/browserclaw/config/mcp-config.json has 0 chrome_* references', () => {
      const configPath = path.resolve(
        __dirname,
        '../../../plugins/browserclaw/skills/browserclaw/config/mcp-config.json',
      );
      if (fs.existsSync(configPath)) {
        const content = fs.readFileSync(configPath, 'utf-8');
        const chromeMatches = content.match(/"chrome_[a-z_]+"/g) || [];
        expect(chromeMatches).toEqual([]);
        expect(content).toContain('browserclaw_read_dom');
      }
    });
  });

  describe('6. batch_actions with fill_form and Dynamic Drift Guard', () => {
    it('aborts batch execution immediately when a field in fill_form fails focus or commitment', async () => {
      (globalThis as any).chrome = {
        tabs: {
          get: vi.fn().mockResolvedValue({ id: 10, url: 'https://example.com/reg' }),
        },
      };

      vi.spyOn(fillCore, 'performPhysicalFill')
        .mockResolvedValueOnce({
          success: true,
          committed: true,
          filledText: 'John',
          isTrusted: true,
          method: 'cdp_native',
        })
        .mockResolvedValueOnce({
          success: false,
          committed: false,
          filledText: 'Doe',
          isTrusted: false,
          method: 'cdp_native',
          error: 'Focus verification failed: target element [2] is not active',
        });

      const res = await batchActionsTool.execute({
        tabId: 10,
        actions: [
          {
            type: 'fill_form',
            fields: [
              { index: 1, value: 'John' },
              { index: 2, value: 'Doe' },
            ],
          } as any,
        ],
      });

      const data = JSON.parse(res.content[0].text);
      expect(data.success).toBe(false);
      expect(data.interruptedReason).toContain('failed');
      expect(data.results[0].success).toBe(false);
      expect(data.results[0].error).toContain('Batch fill_form failed');
      expect(data.results[0].error).toContain('Focus verification failed');
    });

    it('successfully fills multiple fields with dynamic settling and reports success', async () => {
      (globalThis as any).chrome = {
        tabs: {
          get: vi.fn().mockResolvedValue({ id: 10, url: 'https://example.com/reg' }),
        },
      };

      vi.spyOn(fillCore, 'performPhysicalFill')
        .mockResolvedValueOnce({
          success: true,
          committed: true,
          filledText: 'Alice',
          isTrusted: true,
          method: 'cdp_native',
        })
        .mockResolvedValueOnce({
          success: true,
          committed: true,
          filledText: 'Smith',
          isTrusted: true,
          method: 'cdp_native',
        });

      const res = await batchActionsTool.execute({
        tabId: 10,
        actions: [
          {
            type: 'fill_form',
            fields: [
              { index: 1, value: 'Alice' },
              { index: 2, value: 'Smith' },
            ],
          } as any,
        ],
      });

      const data = JSON.parse(res.content[0].text);
      expect(data.success).toBe(true);
      expect(data.results[0].success).toBe(true);
      expect(data.results[0].output.fields).toHaveLength(2);
      expect(data.results[0].output.fields[0].success).toBe(true);
      expect(data.results[0].output.fields[1].success).toBe(true);
    });
  });
});
