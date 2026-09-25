import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  inPageDeepResetElement,
  inPageVerifyInputCommitment,
  inPageDetectPerceptiveSignature,
  computePerceptiveDelta,
  inPageDOMPruner,
  inPageLocateByText,
  getIsolatedIndexMap,
  extractElementLocationDetails,
  wrapElement,
} from '../entrypoints/background/tools/browser/dom-indexer';
import { formPipelineTool } from '../entrypoints/background/tools/browser/form-pipeline';
import * as engine from '../entrypoints/background/tools/browser/in-page-engine';

describe('Next-Gen Architecture: True Input Commitment, Anti-Ghosting & Autonomous Form Pipeline', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    getIsolatedIndexMap().clear();
    vi.clearAllMocks();
  });

  describe('1. Cross-Platform Deep Reset Protocol (inPageDeepResetElement)', () => {
    it('clears standard input and dispatches input/change events', () => {
      const input = document.createElement('input');
      input.value = 'Existing text';
      document.body.appendChild(input);

      let inputFired = false;
      let changeFired = false;
      input.addEventListener('input', () => {
        inputFired = true;
      });
      input.addEventListener('change', () => {
        changeFired = true;
      });

      getIsolatedIndexMap().set(1, input);

      const res = inPageDeepResetElement(1);
      expect(res.success).toBe(true);
      expect(res.cleared).toBe(true);
      expect(res.currentLength).toBe(0);
      expect(input.value).toBe('');
      expect(inputFired).toBe(true);
      expect(changeFired).toBe(true);
    });

    it('resets rich-text contenteditable element contents', () => {
      const editor = document.createElement('div');
      editor.setAttribute('contenteditable', 'true');
      editor.setAttribute('role', 'textbox');
      editor.innerText = 'Draft tweet text';
      document.body.appendChild(editor);

      getIsolatedIndexMap().set(2, editor);

      const res = inPageDeepResetElement(2);
      expect(res.success).toBe(true);
      expect(res.cleared).toBe(true);
      expect(editor.innerText.trim()).toBe('');
      expect(res.isComposer).toBe(true);
    });
  });

  describe('2. True Input Commitment Verification (inPageVerifyInputCommitment)', () => {
    it('verifies standard input commitment and submit button state', () => {
      const form = document.createElement('form');
      const input = document.createElement('input');
      input.value = 'Hello World';
      const submitBtn = document.createElement('button');
      submitBtn.type = 'submit';
      submitBtn.textContent = 'Post';
      submitBtn.disabled = false;

      form.appendChild(input);
      form.appendChild(submitBtn);
      document.body.appendChild(form);

      getIsolatedIndexMap().set(3, input);

      const verified = inPageVerifyInputCommitment(3, 'Hello World');
      expect(verified.committed).toBe(true);
      expect(verified.currentValue).toBe('Hello World');
      expect(verified.submitButtonState?.found).toBe(true);
      expect(verified.submitButtonState?.disabled).toBe(false);
    });

    it('rejects false success when reactive state did not update', () => {
      const form = document.createElement('form');
      const composer = document.createElement('div');
      composer.setAttribute('contenteditable', 'true');
      composer.setAttribute('role', 'textbox');
      composer.setAttribute('data-testid', 'tweetTextarea_0');
      // Composer DOM value is empty (reactive state didn't commit)
      composer.innerText = '';

      const tweetBtn = document.createElement('button');
      tweetBtn.setAttribute('data-testid', 'tweetButton');
      tweetBtn.textContent = 'Tweet';
      tweetBtn.disabled = true; // Still disabled!

      form.appendChild(composer);
      form.appendChild(tweetBtn);
      document.body.appendChild(form);

      getIsolatedIndexMap().set(4, composer);

      const verified = inPageVerifyInputCommitment(4, 'Uncommitted text to tweet');
      expect(verified.committed).toBe(false);
      expect(verified.diagnostics).toContain('did not reflect expected input');
      expect(verified.submitButtonState?.found).toBe(true);
      expect(verified.submitButtonState?.disabled).toBe(true);
    });

    it('rejects similar-length text when content does not match (regression test for Math.abs length heuristic)', () => {
      const input = document.createElement('input');
      input.value = 'hello abc';
      document.body.appendChild(input);

      getIsolatedIndexMap().set(41, input);

      const verified = inPageVerifyInputCommitment(41, 'hello xyz');
      expect(verified.committed).toBe(false);
      expect(verified.diagnostics).toContain('did not reflect expected input');
    });

    it('rejects commitment when composer DOM text matches but tweet/submit button remains disabled', () => {
      const form = document.createElement('form');
      const composer = document.createElement('div');
      composer.setAttribute('contenteditable', 'true');
      composer.setAttribute('role', 'textbox');
      composer.innerText = 'Draft tweet text';

      const tweetBtn = document.createElement('button');
      tweetBtn.setAttribute('data-testid', 'tweetButton');
      tweetBtn.textContent = 'Tweet';
      tweetBtn.disabled = true;

      form.appendChild(composer);
      form.appendChild(tweetBtn);
      document.body.appendChild(form);

      getIsolatedIndexMap().set(42, composer);

      const verified = inPageVerifyInputCommitment(42, 'Draft tweet text');
      expect(verified.committed).toBe(false);
      expect(verified.diagnostics).toContain('remains disabled');
      expect(verified.submitButtonState?.disabled).toBe(true);
    });

    it('prefers the real submit button over a preceding clear/reset control (YouTube search regression)', () => {
      const searchWrapper = document.createElement('div');
      searchWrapper.setAttribute('role', 'search');

      const input = document.createElement('input');
      input.name = 'search_query';
      input.value = 'Pera nai chill';

      // Icon-only "Clear search query" control renders BEFORE the real search button
      const clearBtn = document.createElement('button');
      clearBtn.setAttribute('aria-label', 'Clear search query');
      clearBtn.innerHTML = '<svg></svg>';

      const searchBtn = document.createElement('button');
      searchBtn.id = 'search-icon-legacy';
      searchBtn.setAttribute('aria-label', 'Search');
      searchBtn.innerHTML = '<svg></svg>';

      searchWrapper.appendChild(input);
      searchWrapper.appendChild(clearBtn);
      searchWrapper.appendChild(searchBtn);
      document.body.appendChild(searchWrapper);

      getIsolatedIndexMap().set(60, input);
      getIsolatedIndexMap().set(61, clearBtn);
      getIsolatedIndexMap().set(62, searchBtn);

      const verified = inPageVerifyInputCommitment(60, 'Pera nai chill');
      expect(verified.committed).toBe(true);
      expect(verified.submitButtonState?.found).toBe(true);
      // Must resolve to the real submit button (index 62), never the clear control (index 61)
      expect(verified.submitButtonState?.index).toBe(62);
    });

    it('never selects a destructive reset/clear button when a neutral submit exists', () => {
      const form = document.createElement('form');
      const input = document.createElement('input');
      input.value = 'hello';

      const resetBtn = document.createElement('button');
      resetBtn.type = 'reset';
      resetBtn.textContent = 'Clear form';

      const okBtn = document.createElement('button');
      okBtn.textContent = 'Continue';

      form.appendChild(input);
      form.appendChild(resetBtn);
      form.appendChild(okBtn);
      document.body.appendChild(form);

      getIsolatedIndexMap().set(63, input);
      getIsolatedIndexMap().set(64, resetBtn);
      getIsolatedIndexMap().set(65, okBtn);

      const verified = inPageVerifyInputCommitment(63, 'hello');
      expect(verified.submitButtonState?.index).toBe(65);
    });

    it('normalizes zero-width spaces and non-breaking spaces during comparison', () => {
      const composer = document.createElement('div');
      composer.setAttribute('contenteditable', 'true');
      // DOM contains zero-width spaces and non-breaking space
      composer.innerText = '\u200BHello\u00A0World\uFEFF';
      document.body.appendChild(composer);

      getIsolatedIndexMap().set(43, composer);

      const verified = inPageVerifyInputCommitment(43, 'Hello World');
      expect(verified.committed).toBe(true);
    });

    it('verifies checkbox and radio checked states correctly', () => {
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = true;
      document.body.appendChild(cb);

      getIsolatedIndexMap().set(5, cb);

      const vTrue = inPageVerifyInputCommitment(5, 'true');
      expect(vTrue.committed).toBe(true);

      const vFalse = inPageVerifyInputCommitment(5, 'false');
      expect(vFalse.committed).toBe(false);
    });

    it('verifies select dropdown value or label correctly', () => {
      const select = document.createElement('select');
      const opt1 = document.createElement('option');
      opt1.value = 'US';
      opt1.text = 'United States';
      const opt2 = document.createElement('option');
      opt2.value = 'CN';
      opt2.text = 'China';
      select.appendChild(opt1);
      select.appendChild(opt2);
      select.value = 'CN';
      document.body.appendChild(select);

      getIsolatedIndexMap().set(6, select);

      const vVal = inPageVerifyInputCommitment(6, 'CN');
      expect(vVal.committed).toBe(true);

      const vLabel = inPageVerifyInputCommitment(6, 'China');
      expect(vLabel.committed).toBe(true);

      const vWrong = inPageVerifyInputCommitment(6, 'Japan');
      expect(vWrong.committed).toBe(false);
    });
  });

  describe('3. Perceptive Delta Engine (inPageDetectPerceptiveSignature & computePerceptiveDelta)', () => {
    it('extracts active question, step progress, active inputs, and alerts', () => {
      const container = document.createElement('div');
      const heading = document.createElement('h2');
      heading.className = 'question-text';
      heading.textContent = 'What is your company size?';

      const progress = document.createElement('div');
      progress.className = 'progress-indicator';
      progress.textContent = '3 of 10';

      const input = document.createElement('input');
      input.name = 'companySize';
      input.placeholder = 'Select or type...';

      const alert = document.createElement('div');
      alert.setAttribute('role', 'alert');
      alert.textContent = 'Please make a selection to continue';

      container.appendChild(heading);
      container.appendChild(progress);
      container.appendChild(input);
      container.appendChild(alert);
      document.body.appendChild(container);

      // Mock viewport bounding client rects
      heading.getBoundingClientRect = () =>
        ({ top: 50, bottom: 80, left: 20, right: 300, width: 280, height: 30 }) as any;
      progress.getBoundingClientRect = () =>
        ({ top: 10, bottom: 30, left: 20, right: 100, width: 80, height: 20 }) as any;
      input.getBoundingClientRect = () =>
        ({ top: 100, bottom: 130, left: 20, right: 250, width: 230, height: 30 }) as any;
      alert.getBoundingClientRect = () =>
        ({ top: 140, bottom: 170, left: 20, right: 250, width: 230, height: 30 }) as any;

      const sig = inPageDetectPerceptiveSignature();
      expect(sig.question).toBe('What is your company size?');
      expect(sig.progress).toBe('3 / 10');
      expect(sig.stepCurrent).toBe(3);
      expect(sig.stepTotal).toBe(10);
      expect(sig.activeInputs.length).toBeGreaterThan(0);
      expect(sig.activeInputs[0].name).toBe('companySize');
      expect(sig.alerts).toContain('Please make a selection to continue');
    });

    it('computes perceptive delta between pre and post signatures', () => {
      const pre = {
        question: 'Step 1: Your Name',
        progress: '1 / 5',
        stepCurrent: 1,
        stepTotal: 5,
        activeInputs: [{ tagName: 'input', name: 'fullname' }],
        alerts: [],
        url: 'https://form.example.com/step1',
        title: 'Form',
      };

      const post = {
        question: 'Step 2: Your Email',
        progress: '2 / 5',
        stepCurrent: 2,
        stepTotal: 5,
        activeInputs: [{ tagName: 'input', name: 'email' }],
        alerts: [],
        url: 'https://form.example.com/step2',
        title: 'Form',
      };

      const delta = computePerceptiveDelta(pre, post);
      expect(delta).toBeDefined();
      expect(delta?.advanced).toBe(true);
      expect(delta?.questionChanged).toBe(true);
      expect(delta?.progressChanged).toBe(true);
      expect(delta?.previousQuestion).toBe('Step 1: Your Name');
      expect(delta?.currentQuestion).toBe('Step 2: Your Email');
      expect(delta?.progress).toBe('2 / 5');
    });

    it('filters out ghost question headings and inputs inside aria-hidden or inert ancestors', () => {
      const hiddenSlide = document.createElement('div');
      hiddenSlide.setAttribute('aria-hidden', 'true');
      const ghostHeading = document.createElement('h2');
      ghostHeading.textContent = 'Ghost Step 1: Previous question';
      const ghostInput = document.createElement('input');
      ghostInput.name = 'ghostField';
      hiddenSlide.appendChild(ghostHeading);
      hiddenSlide.appendChild(ghostInput);
      document.body.appendChild(hiddenSlide);

      const activeSlide = document.createElement('div');
      const activeHeading = document.createElement('h2');
      activeHeading.textContent = 'Active Step 2: Current question';
      const activeInput = document.createElement('input');
      activeInput.name = 'activeField';
      activeSlide.appendChild(activeHeading);
      activeSlide.appendChild(activeInput);
      document.body.appendChild(activeSlide);

      ghostHeading.getBoundingClientRect = () =>
        ({ top: 50, bottom: 80, left: 20, right: 300, width: 280, height: 30 }) as any;
      ghostInput.getBoundingClientRect = () =>
        ({ top: 100, bottom: 130, left: 20, right: 250, width: 230, height: 30 }) as any;
      activeHeading.getBoundingClientRect = () =>
        ({ top: 50, bottom: 80, left: 20, right: 300, width: 280, height: 30 }) as any;
      activeInput.getBoundingClientRect = () =>
        ({ top: 100, bottom: 130, left: 20, right: 250, width: 230, height: 30 }) as any;

      const sig = inPageDetectPerceptiveSignature();
      expect(sig.question).toBe('Active Step 2: Current question');
      expect(sig.activeInputs.some((i) => i.name === 'ghostField')).toBe(false);
      expect(sig.activeInputs.some((i) => i.name === 'activeField')).toBe(true);
    });

    it('recognizes advance when question disappears or active inputs clear out upon completion', () => {
      const pre = {
        question: 'Final Question',
        progress: '5 / 5',
        stepCurrent: 5,
        stepTotal: 5,
        activeInputs: [{ tagName: 'input', name: 'signature' }],
        alerts: [],
      };
      const post = {
        question: undefined,
        progress: undefined,
        activeInputs: [],
        alerts: [],
      };

      const delta = computePerceptiveDelta(pre, post);
      expect(delta).toBeDefined();
      expect(delta?.advanced).toBe(true);
      expect(delta?.questionChanged).toBe(true);
      expect(delta?.progressChanged).toBe(true);
      expect(delta?.previousQuestion).toBe('Final Question');
      expect(delta?.currentQuestion).toBeUndefined();
    });
  });

  describe('4. Anti-Ghosting: Frustum Clipping & Inherited Culling in inPageDOMPruner', () => {
    it('culls elements and subtrees with pointer-events: none, inert, or aria-hidden=true', () => {
      const visibleBox = document.createElement('button');
      visibleBox.textContent = 'Active Visible Button';
      document.body.appendChild(visibleBox);

      const hiddenContainer = document.createElement('div');
      hiddenContainer.setAttribute('inert', 'true');
      const ghostBtn = document.createElement('button');
      ghostBtn.textContent = 'Ghost Inactive Button';
      hiddenContainer.appendChild(ghostBtn);
      document.body.appendChild(hiddenContainer);

      visibleBox.getBoundingClientRect = () =>
        ({ top: 100, bottom: 130, left: 50, right: 150, width: 100, height: 30 }) as any;
      ghostBtn.getBoundingClientRect = () =>
        ({ top: 100, bottom: 130, left: 50, right: 150, width: 100, height: 30 }) as any;

      const res = inPageDOMPruner({ activeViewportOnly: true });
      expect(res.treeString).toContain('Active Visible Button');
      expect(res.treeString).not.toContain('Ghost Inactive Button');
    });

    it('clips horizontally off-screen carousel / wizard elements when activeViewportOnly is true', () => {
      const activeSlide = document.createElement('button');
      activeSlide.textContent = 'Active Slide Button';
      document.body.appendChild(activeSlide);

      const offscreenSlide = document.createElement('button');
      offscreenSlide.textContent = 'Offscreen Carousel Button';
      document.body.appendChild(offscreenSlide);

      // In viewport (window width is typically 1024 or 1280 in tests)
      activeSlide.getBoundingClientRect = () =>
        ({ top: 100, bottom: 130, left: 100, right: 300, width: 200, height: 30 }) as any;
      // Offscreen to the right (left = 2500)
      offscreenSlide.getBoundingClientRect = () =>
        ({ top: 100, bottom: 130, left: 2500, right: 2700, width: 200, height: 30 }) as any;

      const res = inPageDOMPruner({ activeViewportOnly: true });
      expect(res.treeString).toContain('Active Slide Button');
      expect(res.treeString).not.toContain('Offscreen Carousel Button');
    });
  });

  describe('5. Active Viewport Bias in inPageLocateByText', () => {
    it('prioritizes element in active viewport over off-screen duplicate text element', () => {
      const offscreenBtn = document.createElement('button');
      offscreenBtn.textContent = 'Continue';
      document.body.appendChild(offscreenBtn);

      const inViewportBtn = document.createElement('button');
      inViewportBtn.textContent = 'Continue';
      document.body.appendChild(inViewportBtn);

      offscreenBtn.getBoundingClientRect = () =>
        ({ top: -1500, bottom: -1450, left: 100, right: 200, width: 100, height: 50 }) as any;
      inViewportBtn.getBoundingClientRect = () =>
        ({ top: 200, bottom: 250, left: 100, right: 200, width: 100, height: 50 }) as any;

      getIsolatedIndexMap().set(10, offscreenBtn);
      getIsolatedIndexMap().set(11, inViewportBtn);

      const loc = inPageLocateByText('Continue', 'button');
      expect(loc.success).toBe(true);
      // In-viewport element has +1000 score bonus and must be picked (y = 225 vs y = -1475)
      expect(loc.y).toBeGreaterThan(0);
    });

    it('ignores elements contained within aria-hidden="true" or inert ancestors', () => {
      const hiddenContainer = document.createElement('div');
      hiddenContainer.setAttribute('aria-hidden', 'true');
      const hiddenBtn = document.createElement('button');
      hiddenBtn.textContent = 'Submit Hidden';
      hiddenContainer.appendChild(hiddenBtn);
      document.body.appendChild(hiddenContainer);

      hiddenBtn.getBoundingClientRect = () =>
        ({ top: 100, bottom: 130, left: 100, right: 200, width: 100, height: 30 }) as any;
      getIsolatedIndexMap().set(12, hiddenBtn);

      const loc = inPageLocateByText('Submit Hidden', 'button');
      expect(loc.success).toBe(false);
    });
  });

  describe('6. Autonomous Form Pipeline Tool (chrome_form_pipeline)', () => {
    it('validates fields parameter is required non-empty array', async () => {
      const res = await formPipelineTool.execute({ fields: [] });
      expect(res.isError).toBe(true);
    });

    it('autonomously matches questions, fills inputs, and reports completed status', async () => {
      (globalThis.chrome.tabs as any).get = vi.fn().mockResolvedValue({
        id: 200,
        url: 'https://example.com/onboarding',
      });

      vi.spyOn(formPipelineTool as any, 'resolveAffinityTab').mockResolvedValue({
        id: 200,
        url: 'https://example.com/onboarding',
      });

      let step = 1;
      vi.spyOn(engine, 'executeInPage').mockImplementation(
        async (_target: any, fnName: string, args: any[]) => {
          if (fnName === 'inPageCheckCaptcha') {
            return [{ result: { detected: false } }] as any;
          }
          if (fnName === 'inPageDetectPerceptiveSignature') {
            if (step === 1) {
              return [
                {
                  result: {
                    question: 'What is your username?',
                    progress: '1 / 2',
                    activeInputs: [{ index: 1, name: 'username', tagName: 'input' }],
                    alerts: [],
                  },
                },
              ] as any;
            } else if (step === 2) {
              return [
                {
                  result: {
                    question: 'What is your team size?',
                    progress: '2 / 2',
                    activeInputs: [{ index: 2, name: 'teamSize', tagName: 'input' }],
                    alerts: [],
                  },
                },
              ] as any;
            } else {
              return [
                {
                  result: {
                    question: 'All set! Welcome aboard.',
                    progress: '2 / 2',
                    activeInputs: [],
                    alerts: [],
                  },
                },
              ] as any;
            }
          }
          if (fnName === 'inPageLocateByText') {
            return [{ result: { success: true, index: 99, tagName: 'button' } }] as any;
          }
          if (fnName === 'inPageGetElementCoordinates') {
            return [{ result: { success: true, x: 100, y: 100, tagName: 'input' } }] as any;
          }
          if (fnName === 'inPageVerifyInputCommitment') {
            step++;
            return [{ result: { success: true, committed: true } }] as any;
          }
          if (fnName === 'inPageFillIndex') {
            step++;
            return [{ result: { success: true, committed: true } }] as any;
          }
          if (fnName === 'inPageWaitForDOMSettle') {
            return [{ result: { settled: true, durationMs: 0, mutationsObserved: 0 } }] as any;
          }
          return [{ result: { success: true } }] as any;
        },
      );

      const res = await formPipelineTool.execute({
        fields: [
          { query: 'username', value: 'agent_user' },
          { query: 'team size', value: '10' },
        ],
        tabId: 200,
        maxSteps: 5,
      });

      expect(res.isError).toBe(false);
      const payload = JSON.parse(res.content[0].text);
      expect(payload.status).toBe('completed');
      expect(payload.completedFields.length).toBe(2);
    });

    it('interrupts execution with advance_stuck when form fails to advance 2 consecutive steps', async () => {
      (globalThis.chrome.tabs as any).get = vi.fn().mockResolvedValue({
        id: 205,
        url: 'https://example.com/stuck-wizard',
      });

      vi.spyOn(formPipelineTool as any, 'resolveAffinityTab').mockResolvedValue({
        id: 205,
        url: 'https://example.com/stuck-wizard',
      });

      // Page refuses to advance (same question, same inputs, same progress across all steps)
      vi.spyOn(engine, 'executeInPage').mockImplementation(async (_target: any, fnName: string) => {
        if (fnName === 'inPageCheckCaptcha') {
          return [{ result: { detected: false } }] as any;
        }
        if (fnName === 'inPageDetectPerceptiveSignature') {
          return [
            {
              result: {
                question: 'Question 1: Stalled Step',
                progress: '1 / 3',
                activeInputs: [{ index: 10, name: 'stalledInput', tagName: 'input' }],
                alerts: [],
              },
            },
          ] as any;
        }
        if (fnName === 'inPageLocateByText') {
          return [{ result: { success: false } }] as any;
        }
        if (fnName === 'inPageGetElementCoordinates') {
          return [{ result: { success: true, x: 100, y: 100, tagName: 'input' } }] as any;
        }
        if (fnName === 'inPageVerifyInputCommitment') {
          return [{ result: { success: true, committed: true } }] as any;
        }
        if (fnName === 'inPageWaitForDOMSettle') {
          return [{ result: { settled: true, durationMs: 0, mutationsObserved: 0 } }] as any;
        }
        return [{ result: { success: true } }] as any;
      });

      const res = await formPipelineTool.execute({
        fields: [
          { query: 'stalledInput', value: 'my-input' },
          { query: 'nextInput', value: 'will-not-reach' },
        ],
        tabId: 205,
        maxSteps: 5,
      });

      expect(res.isError).toBe(true);
      const payload = JSON.parse(res.content[0].text);
      expect(payload.status).toBe('interrupted');
      expect(payload.reason).toBe('advance_stuck');
      expect(payload.interruptDetails?.fieldQuery).toBe('stalledInput');
    });

    it('interrupts execution immediately upon CAPTCHA detection', async () => {
      (globalThis.chrome.tabs as any).get = vi.fn().mockResolvedValue({
        id: 201,
        url: 'https://example.com/challenge',
      });

      vi.spyOn(formPipelineTool as any, 'resolveAffinityTab').mockResolvedValue({
        id: 201,
        url: 'https://example.com/challenge',
      });

      vi.spyOn(engine, 'executeInPage').mockImplementation(async (_target: any, fnName: string) => {
        if (fnName === 'inPageCheckCaptcha') {
          return [{ result: { detected: true, type: '.cf-turnstile' } }] as any;
        }
        return [{ result: { success: true } }] as any;
      });

      const res = await formPipelineTool.execute({
        fields: [{ query: 'name', value: 'Alice' }],
        tabId: 201,
      });

      expect(res.isError).toBe(true);
      const payload = JSON.parse(res.content[0].text);
      expect(payload.status).toBe('interrupted');
      expect(payload.reason).toBe('captcha_detected');
      expect(payload.interruptDetails?.captchaType).toBe('.cf-turnstile');
    });
  });

  describe('6. Robust Text Location, Options Support & Index Isolation Hardening', () => {
    it('inPageLocateByText safely accepts options object without throwing role.toLowerCase TypeError', () => {
      const btn = document.createElement('button');
      btn.textContent = 'Accept & Proceed';
      btn.setAttribute('role', 'button');
      btn.getBoundingClientRect = () =>
        ({
          top: 10,
          left: 10,
          bottom: 40,
          right: 100,
          width: 90,
          height: 30,
        }) as any;
      document.body.appendChild(btn);

      // Verify options object passed by form-pipeline.ts { exact: false, visibleOnly: true, threshold: 0 }
      const res = inPageLocateByText('Accept & Proceed', {
        exact: false,
        visibleOnly: true,
        threshold: 0,
      } as any);

      expect(res.success).toBe(true);
      expect(res.tagName).toBe('button');
      expect(res.role).toBe('button');
      expect(res.isClickable).toBe(true);
      expect(typeof res.index).toBe('number');
    });

    it('extractElementLocationDetails 2-pass matching prevents parent container from stealing child element index', () => {
      const map = getIsolatedIndexMap();

      // Parent container (e.g. form or card) indexed at index 1
      const form = document.createElement('form');
      form.id = 'survey-form';
      const submitBtn = document.createElement('button');
      submitBtn.type = 'submit';
      submitBtn.textContent = 'Submit Answers';
      form.appendChild(submitBtn);
      document.body.appendChild(form);

      // Register container at index 1
      map.set(1, wrapElement(form));

      // Extract location for submitBtn
      const loc = extractElementLocationDetails(submitBtn);

      expect(loc.success).toBe(true);
      // Under old bug: target.contains(el) matched form, assigning index 1 to the button!
      // Under 2-pass fix: button receives its own distinct index (2)
      expect(loc.index).not.toBe(1);
      expect(loc.index).toBe(2);
      expect(loc.isClickable).toBe(true);
      expect(loc.role).toBeUndefined(); // native button has no explicit role attribute
    });

    it('inPageVerifyInputCommitment submitButtonState allocates distinct index without container collision', () => {
      const map = getIsolatedIndexMap();

      const form = document.createElement('form');
      const input = document.createElement('input');
      input.type = 'text';
      input.name = 'email';
      const submitBtn = document.createElement('button');
      submitBtn.type = 'submit';
      submitBtn.textContent = 'Continue';
      form.appendChild(input);
      form.appendChild(submitBtn);
      document.body.appendChild(form);

      // Register form at index 10
      map.set(10, wrapElement(form));
      // Register input at index 11
      map.set(11, wrapElement(input));

      input.value = 'user@example.com';
      const verification = inPageVerifyInputCommitment(11, 'user@example.com');

      expect(verification.committed).toBe(true);
      expect(verification.submitButtonState?.found).toBe(true);
      // Must NOT be the form's index 10!
      expect(verification.submitButtonState?.index).not.toBe(10);
      expect(verification.submitButtonState?.index).toBe(12);
    });
  });
});
