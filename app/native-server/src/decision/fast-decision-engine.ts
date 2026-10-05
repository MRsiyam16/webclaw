import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
/**
 * Fast Decision Engine conforming to §4, §5, §6
 * Semantic micro-loop inside Native Server (~200-400ms/step).
 */

import {
  ActTowardGoalParams,
  ActTowardGoalResult,
  ActTowardGoalStatus,
  DecisionEngineType,
  FallbackReason,
  ActionHistoryItem,
  PageState,
  PausedBeforeAction,
  DecisionStep,
} from './types';
import { extractTextPayload, isDestructiveTarget } from './decision-utils';
import { HeuristicEngine } from './heuristic-engine';
import { getPermittedNextTiers } from './local-decision-policy';
import type { LocalDecisionMode, LocalDecisionDiagnostics } from './types';
import { decideWithTev1, selectTev1Candidates } from './tev1-client';

/**
 * Match element text or action against configured safety breakpoints.
 */
export function findMatchingPauseKeyword(targetText: string, keywords?: string[]): string | null {
  if (!targetText || !keywords || !Array.isArray(keywords) || keywords.length === 0) {
    return null;
  }
  const textLower = targetText.toLowerCase();
  for (const kw of keywords) {
    if (!kw || typeof kw !== 'string') continue;
    const cleanKw = kw.trim();
    if (!cleanKw) continue;
    const kwLower = cleanKw.toLowerCase();

    // If keyword consists of alphanumeric/dash words (Latin/standard token), match on word boundaries
    // to prevent false positives like "postal_code" matching "post" or "deposit" matching "post"
    if (/^[a-zA-Z0-9_-]+$/.test(cleanKw)) {
      const regex = new RegExp(
        `(^|[^a-zA-Z0-9])${cleanKw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[^a-zA-Z0-9]|$)`,
        'i',
      );
      if (regex.test(targetText)) {
        return cleanKw;
      }
    } else {
      // Non-Latin/CJK characters (e.g. "确认提交", "发布", "付款") - substring match
      if (textLower.includes(kwLower)) {
        return cleanKw;
      }
    }
  }
  return null;
}

/** True only for an unchained, single direct atomic action request. */
function isExplicitOneShotGoal(goal: string): boolean {
  const normalized = goal
    .replace(/"[^"\\]*(?:\\.[^"\\]*)*"|'[^'\\]*(?:\\.[^'\\]*)*'/g, ' ')
    .replace(
      /\b(?:button|link|checkbox|radio|tab|menu item)\s+(?:labeled\s+|named\s+)?[^,;.!?]+/gi,
      ' ',
    )
    .trim();
  if (!normalized || /\b(?:then|after|until|and)\b/i.test(normalized)) return false;
  const verbs =
    normalized.match(
      /\b(?:click|tap|press|type|enter|fill|select|choose|open|close|scroll|navigate|go|submit)\b/gi,
    ) || [];
  return (
    verbs.length === 1 &&
    /\b(?:click|tap|press|type|enter|fill|select|choose|open|close)\b/i.test(normalized)
  );
}

export function containsProhibitedGoal(goal: string): boolean {
  return /(?:^|[^\p{L}\p{N}])(?:payment|checkout|buy|order|booking|subscribe|publish|post|send|share|delete|remove|reset|clear|cancel|undo|discard|login|password|otp|passkey|account|security|upload|download|permissions?)(?=$|[^\p{L}\p{N}])/iu.test(
    goal,
  );
}

function redactSensitiveLabeledValues(value: string): string {
  const sensitiveLabel =
    /password|passwd|passcode|secret|token|api.?key|authorization|credit.?card|card.?number|cc.?number|cvc|cvv|security.?code|one.?time.?code|otp/i;
  const quoted = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'/g;
  return value.replace(
    quoted,
    (whole, doubleText: string, singleText: string, offset: number, source: string) => {
      const label = doubleText ?? singleText ?? '';
      if (!sensitiveLabel.test(label)) return whole;
      const before = source.slice(0, offset);
      const prefix = before.match(/\b(?:value|text|payload)\s*[:=]\s*$/i);
      if (prefix) return `${whole[0]}[REDACTED]${whole[0]}`;
      return `${whole[0]}${label.replace(/[:=].*$/, '')} [REDACTED]${whole[0]}`;
    },
  );
}

function redactCredentialAssignments(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(
      /\b(password|passwd|passcode|secret|token|access_token|auth|authorization|api[_-]?key|card|cc[_-]?(?:number|num)|cvc|cvv|security[_-]?code)\b\s*([:=])\s*(?:"[^"]*"|'[^']*'|[^\s,;}&]+)/gi,
      '$1$2[REDACTED]',
    );
}

/** Parse a positional element index from the accessible tree. */
function getPositionalElementIndex(line: string): string | undefined {
  return line.match(/^\[(\d+)(?:\|e\d+)?\]/)?.[1];
}

function getPrimaryAccessibleName(line: string): string | undefined {
  const match = line.match(
    /^\[\d+(?:\|e\d+)?\]\s+(?:\[[^\]]+\]\s+)*(?:button|link|checkbox|radio|tab|menuitem|switch|option|combobox|select)\s+"([^"]*)"/i,
  );
  return match?.[1].trim().replace(/\s+/g, ' ').toLowerCase() || undefined;
}

export function hasDuplicateClickableAccessibleName(
  targetLine: string,
  targetIndex: number | undefined,
  elements: string[],
): boolean {
  const targetName = getPrimaryAccessibleName(targetLine);
  if (!targetName || targetIndex === undefined) return false;
  return elements.some(
    (line) =>
      getPositionalElementIndex(line) !== String(targetIndex) &&
      getPrimaryAccessibleName(line) === targetName,
  );
}

function isSafeTev1Target(
  line: string,
  attributes: Record<string, unknown>,
  text: string,
): boolean {
  const type = typeof attributes.type === 'string' ? attributes.type.toLowerCase() : '';
  if (type === 'reset' || type === 'submit') return false;
  const labels = [text, attributes['aria-label'], attributes.title].filter(
    (value): value is string => typeof value === 'string',
  );
  const destructiveLabel =
    /(?:^|[^\p{L}\p{N}])(?:delete|remove|reset|clear|publish|send|purchase|pay|confirm)(?=$|[^\p{L}\p{N}])/iu;
  if (labels.some((label) => destructiveLabel.test(label) || isDestructiveTarget(label)))
    return false;
  return !isDestructiveTarget(line);
}

export class FastDecisionEngine {
  private heuristicEngine: HeuristicEngine;
  private readonly localDecisionMode: LocalDecisionMode;
  private readonly tev1Enabled: boolean;

  constructor(
    mode: LocalDecisionMode = 'auto',
    options: { tev1Enabled?: boolean; tev1Fetch?: typeof fetch } = {},
  ) {
    this.localDecisionMode = mode;
    this.tev1Enabled = options.tev1Enabled ?? false;
    this.tev1Fetch = options.tev1Fetch;
    this.heuristicEngine = new HeuristicEngine();
  }
  private readonly tev1Fetch?: typeof fetch;

  /**
   * Run semantic micro-loop toward goal
   */
  public async run(
    params: ActTowardGoalParams,
    internalCaller: (toolName: string, args: any) => Promise<any>,
    server?: Server,
  ): Promise<ActTowardGoalResult> {
    let engine: DecisionEngineType = 'heuristic';
    const fallbackReason: FallbackReason = null;
    const engineSwitched = false;

    // Parameter bounds enforcement (§4.4)
    let maxSteps = typeof params.maxSteps === 'number' ? params.maxSteps : 10;
    maxSteps = Math.min(Math.max(1, maxSteps), 5);

    const timeoutMs = Math.min(Math.max(1, params.timeoutMs ?? 90_000), 300_000);
    const confidenceThreshold = params.confidenceThreshold ?? 0.55;
    const startTime = Date.now();

    const steps: DecisionStep[] = [];
    const history: ActionHistoryItem[] = [];
    let localDecision: LocalDecisionDiagnostics | undefined;

    let finalPage: PageState = { url: '', title: '' };
    let currentElements: string[] = [];

    const sendProgress = (stepNum: number, desc: string) => {
      if (
        server &&
        typeof (server as any).notification === 'function' &&
        params._meta?.progressToken !== undefined
      ) {
        (server as any)
          .notification({
            method: 'notifications/progress',
            params: {
              progressToken: params._meta.progressToken,
              progress: stepNum,
              total: maxSteps,
              message: `Step ${stepNum}/${maxSteps}: ${desc}`,
            },
          })
          .catch(() => {});
      }
    };

    for (let step = 1; step <= maxSteps; step++) {
      // Check wall-clock timeout
      if (Date.now() - startTime >= timeoutMs) {
        return this.formatResult(
          'timeout',
          engine,
          engineSwitched,
          fallbackReason,
          `Execution exceeded timeoutMs (${timeoutMs}ms)`,
          steps,
          finalPage,
          currentElements,
        );
      }

      // Step 1: Perceive via internal chrome_read_dom (compact, active viewport only)
      let domData: any = {};
      try {
        const domResult = await internalCaller('chrome_read_dom', {
          tabId: params.tabId,
          activeViewportOnly: true,
          deltaOnly: false,
          includeDetails: this.tev1Enabled,
          limit: 250,
          sessionId: params.sessionId || params.sessionContext,
        });
        const textContent = domResult?.content?.[0]?.text;
        domData = textContent ? JSON.parse(textContent) : {};
      } catch (err: any) {
        return this.formatResult(
          'blocked',
          engine,
          engineSwitched,
          fallbackReason,
          `Failed to read page DOM: ${err?.message || err}`,
          steps,
          finalPage,
          currentElements,
        );
      }

      finalPage = {
        url: domData.tabUrl || '',
        title: domData.tabTitle || '',
      };

      const treeString: string = domData.treeString || '';
      currentElements = treeString
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);

      // Reject risky goals before either local decision tier can run.
      if (containsProhibitedGoal(params.goal || '')) {
        const matchedPauseKeyword = findMatchingPauseKeyword(
          params.goal || '',
          params.pauseBeforeKeywords,
        );
        if (matchedPauseKeyword) {
          const matchingTarget = currentElements.find((line) =>
            findMatchingPauseKeyword(line, [matchedPauseKeyword]),
          );
          return this.formatResult(
            'paused',
            'heuristic',
            false,
            null,
            'Paused before local decision: configured safety keyword',
            [],
            finalPage,
            currentElements,
            {
              action: /\b(type|fill|enter)\b/i.test(params.goal) ? 'type' : 'click',
              ...(matchingTarget ? { target: matchingTarget } : {}),
              matchedKeyword: matchedPauseKeyword,
            },
          );
        }
        return this.formatResult(
          'escalate',
          'heuristic',
          false,
          null,
          'Blocked before local decision: risky goal',
          [],
          finalPage,
          currentElements,
          undefined,
          undefined,
          params.goal,
        );
      }

      // A decisive destructive heuristic choice is terminal before local execution. Keep
      // pause keywords ahead of this guard, and let ambiguous candidates route normally.
      if (getPermittedNextTiers(this.localDecisionMode, 'safe').includes('heuristic')) {
        const targetSafetyDecision = this.heuristicEngine.evaluate(
          params.goal,
          currentElements,
          history,
          Math.min(confidenceThreshold, 0.9),
        );
        const topCandidate = targetSafetyDecision.topCandidates[0];
        const runnerUp = targetSafetyDecision.topCandidates[1];
        const decisive =
          targetSafetyDecision.targetIndex !== undefined &&
          !!targetSafetyDecision.targetLine &&
          !!topCandidate &&
          targetSafetyDecision.confidence >= Math.min(confidenceThreshold, 0.9) &&
          (!runnerUp || topCandidate.score - runnerUp.score >= 0.05);
        const pauseKeyword = findMatchingPauseKeyword(
          targetSafetyDecision.targetLine || '',
          params.pauseBeforeKeywords,
        );
        if (decisive && !pauseKeyword && isDestructiveTarget(targetSafetyDecision.targetLine!)) {
          return this.formatResult(
            'escalate',
            'heuristic',
            false,
            null,
            'Blocked before local decision: destructive target',
            steps,
            finalPage,
            currentElements,
          );
        }
      }

      if (engine === 'heuristic' && this.heuristicEngine.isStuck(history)) {
        return this.formatResult(
          'stuck',
          engine,
          engineSwitched,
          fallbackReason,
          'Stuck: consecutive actions produced no DOM mutation or URL change',
          steps,
          finalPage,
          currentElements,
        );
      }

      // In Heuristic mode, check goal_done approximation before action (§4.3)
      if (engine === 'heuristic' && step > 1) {
        const lastOutcome = history.length > 0 ? history[history.length - 1].outcome : '';
        const urlChangedInLastStep = /urlChanged:true/i.test(lastOutcome);
        const mutatedInLastStep = /mutated:true/i.test(lastOutcome);
        if (
          this.heuristicEngine.isGoalDone(
            params.goal,
            currentElements,
            urlChangedInLastStep,
            mutatedInLastStep,
          )
        ) {
          return this.formatResult(
            'done',
            engine,
            engineSwitched,
            fallbackReason,
            'Goal accomplished (keyword coverage >= 80%)',
            steps,
            finalPage,
            currentElements,
          );
        }
      }

      // Step 2: Select a safe local tier before local execution.
      let actionToTake: string = 'escalate';
      let targetIndex: number | undefined;
      let targetLine: string = '';
      let confidence: number = 0;
      const suggestion: any = undefined;
      let escalateReason: string | undefined;
      let initialHeuristicDecision: ReturnType<HeuristicEngine['evaluate']> | undefined;
      const permittedTiers = getPermittedNextTiers(this.localDecisionMode, 'safe');
      const heuristicStartedAt = Date.now();
      // Tev1 is a tie-breaker, not a replacement for a decisive deterministic choice.
      // Preview the same bounded heuristic first so clear actions never incur model latency.
      const heuristicPreview = permittedTiers.includes('heuristic')
        ? this.heuristicEngine.evaluate(
            params.goal,
            currentElements,
            history,
            Math.min(confidenceThreshold, 0.9),
          )
        : undefined;
      const previewCandidate = heuristicPreview?.topCandidates[0];
      const previewRunnerUp = heuristicPreview?.topCandidates[1];
      const previewLine = heuristicPreview?.targetLine;
      const previewIndex = heuristicPreview?.targetIndex;
      const previewObserved = Array.isArray(domData.indexedElements)
        ? domData.indexedElements.find(
            (el: any) =>
              el?.index === previewIndex &&
              el?.ref &&
              currentElements.some((line) => line.startsWith(`[${previewIndex}|${el.ref}]`)),
          )
        : undefined;
      const role = String(previewObserved?.role || previewObserved?.tagName || '').toLowerCase();
      const heuristicIsDecisive = Boolean(
        this.tev1Enabled &&
        domData.snapshotId &&
        previewObserved?.frameId === 'top' &&
        previewObserved?.isInteractive &&
        !previewObserved?.isOccluded &&
        /^e\d+$/.test(previewObserved?.ref || '') &&
        ['button', 'a', 'link'].includes(role) &&
        isSafeTev1Target(
          previewLine || '',
          previewObserved?.attributes || {},
          String(previewObserved?.text ?? ''),
        ) &&
        heuristicPreview &&
        !heuristicPreview.shouldEscalate &&
        previewIndex !== undefined &&
        previewLine &&
        !isDestructiveTarget(previewLine) &&
        previewCandidate &&
        (!previewRunnerUp || previewCandidate.score - previewRunnerUp.score >= 0.05),
      );
      if (this.tev1Enabled && permittedTiers.includes('heuristic') && !heuristicIsDecisive) {
        // Tev1 is eligible only with a complete fresh observation carrying explicit
        // top-frame metadata and canonical refs. Compact text alone cannot authorize dispatch.
        const observed = Array.isArray(domData.indexedElements) ? domData.indexedElements : [];
        const snapshotId = domData.snapshotId;
        const candidates = observed.flatMap((el: any) => {
          const ref = el?.ref;
          const index = el?.index;
          const line = currentElements.find((item) => item.startsWith(`[${index}|${ref}]`));
          const attrs = el?.attributes || {};
          const role = String(el?.role || el?.tagName || '').toLowerCase();
          if (
            !snapshotId ||
            el?.frameId !== 'top' ||
            !el?.isInteractive ||
            el?.isOccluded ||
            !/^e\d+$/.test(ref || '') ||
            !Number.isInteger(index) ||
            !line ||
            attrs.disabled !== undefined ||
            String(attrs['aria-disabled']).toLowerCase() === 'true' ||
            attrs.type === 'password' ||
            !['button', 'a', 'link'].includes(role) ||
            !isSafeTev1Target(line, attrs, String(el?.text ?? ''))
          )
            return [];
          return [
            {
              id: ref,
              text: line.slice(0, 220),
              enabled: true,
              index,
              line,
              snapshotId,
              attributes: attrs,
              visibleText: String(el?.text ?? ''),
            },
          ];
        });
        const ids = new Set(candidates.map((c: any) => c.id));
        if (!candidates.length || ids.size !== candidates.length) {
          const reason = 'Tev1 requires fresh, unique, explicitly top-frame observed candidates';
          return this.formatResult(
            'escalate',
            engine,
            false,
            null,
            reason,
            steps,
            finalPage,
            currentElements,
            undefined,
            { tier: 'cloud_escalation', reason, candidateCount: candidates.length, elapsedMs: 0 },
            params.goal,
          );
        }
        const requestCandidates = selectTev1Candidates(params.goal, candidates);
        try {
          const selectedRef = await decideWithTev1(
            params.goal,
            requestCandidates.map(({ id, text, enabled }: any) => ({ id, text, enabled })),
            { enabled: true, fetcher: this.tev1Fetch },
          );
          const selected = candidates.find((candidate: any) => candidate.id === selectedRef);
          if (
            !selected ||
            selected.snapshotId !== snapshotId ||
            !isSafeTev1Target(selected.line, selected.attributes, selected.visibleText) ||
            currentElements.filter((item) => item.startsWith(`[${selected.index}|${selectedRef}]`))
              .length !== 1
          )
            throw new Error(
              'Selected candidate no longer uniquely matches a safe observed snapshot target',
            );
          initialHeuristicDecision = {
            action: 'click',
            targetIndex: selected.index,
            targetLine: selected.line,
            confidence: 1,
            topCandidates: [],
            shouldEscalate: false,
          };
          localDecision = {
            tier: 'heuristic',
            reason: `Tev1 selected a validated observed candidate (${requestCandidates.length}/${candidates.length} goal-ranked eligible)`,
            candidateCount: candidates.length,
            elapsedMs: Date.now() - heuristicStartedAt,
          };
          actionToTake = 'click';
          targetIndex = selected.index;
          targetLine = selected.line;
          confidence = 1;
          engine = 'heuristic';
        } catch (error: any) {
          const reason = `Tev1 abstained or failed closed: ${error?.message || error}`;
          return this.formatResult(
            'escalate',
            engine,
            false,
            null,
            reason,
            steps,
            finalPage,
            currentElements,
            undefined,
            {
              tier: 'cloud_escalation',
              reason,
              candidateCount: candidates.length,
              elapsedMs: Date.now() - heuristicStartedAt,
            },
            params.goal,
          );
        }
      } else if (permittedTiers.includes('heuristic')) {
        initialHeuristicDecision = this.heuristicEngine.evaluate(
          params.goal,
          currentElements,
          history,
          Math.min(confidenceThreshold, 0.9),
        );
        const candidate = initialHeuristicDecision.topCandidates[0];
        const runnerUp = initialHeuristicDecision.topCandidates[1];
        const HEURISTIC_DECISIVE_MARGIN = 0.05;
        const decisive =
          !initialHeuristicDecision.shouldEscalate &&
          initialHeuristicDecision.targetIndex !== undefined &&
          !!initialHeuristicDecision.targetLine &&
          !isDestructiveTarget(initialHeuristicDecision.targetLine) &&
          !!candidate &&
          (!runnerUp || candidate.score - runnerUp.score >= HEURISTIC_DECISIVE_MARGIN);
        if (decisive) {
          localDecision = {
            tier: 'heuristic',
            reason: 'Decisive safe heuristic candidate',
            candidateCount: initialHeuristicDecision.topCandidates.length,
            elapsedMs: Date.now() - heuristicStartedAt,
          };
          engine = 'heuristic';
          actionToTake = initialHeuristicDecision.action;
          targetIndex = initialHeuristicDecision.targetIndex;
          targetLine = initialHeuristicDecision.targetLine!;
          confidence = initialHeuristicDecision.confidence;
        } else {
          const reason =
            initialHeuristicDecision.reason ||
            'Local heuristic was not decisive; cloud escalation required';
          return this.formatResult(
            'escalate',
            'heuristic',
            false,
            null,
            reason,
            steps,
            finalPage,
            currentElements,
            undefined,
            {
              tier: 'cloud_escalation',
              reason,
              candidateCount: initialHeuristicDecision.topCandidates.length,
              elapsedMs: Date.now() - heuristicStartedAt,
            },
            params.goal,
          );
        }
      } else {
        return this.formatResult(
          'escalate',
          'heuristic',
          false,
          null,
          'Local decisions are disabled; cloud escalation required',
          steps,
          finalPage,
          currentElements,
          undefined,
          {
            tier: 'cloud_escalation',
            reason: 'Local decisions are disabled',
            candidateCount: 0,
            elapsedMs: 0,
          },
          params.goal,
        );
      }

      // If engine is heuristic (either by default or downgraded)
      if (engine === 'heuristic') {
        const decision =
          initialHeuristicDecision ??
          this.heuristicEngine.evaluate(
            params.goal,
            currentElements,
            history,
            Math.min(confidenceThreshold, 0.9),
          );
        actionToTake = decision.action;
        targetIndex = decision.targetIndex;
        targetLine = decision.targetLine || (targetIndex ? `[${targetIndex}]` : '');
        confidence = decision.confidence;

        // Safety Breakpoint Guard priority check: if candidate matches pauseBeforeKeywords, pause instead of escalate
        if (
          params.pauseBeforeKeywords &&
          Array.isArray(params.pauseBeforeKeywords) &&
          params.pauseBeforeKeywords.length > 0
        ) {
          let pauseAction = actionToTake;
          if (pauseAction === 'escalate') {
            if (targetLine && /(textbox|searchbox|input)/i.test(targetLine)) {
              pauseAction = 'type';
            } else if (targetLine && /(select|combobox)/i.test(targetLine)) {
              pauseAction = 'select';
            } else {
              pauseAction = 'click';
            }
          }
          const checkTarget = targetLine
            ? `${targetLine}${pauseAction === 'submit' ? ' submit' : ''}`
            : targetIndex !== undefined
              ? `[${targetIndex}]`
              : pauseAction;
          const matchedKw = findMatchingPauseKeyword(checkTarget, params.pauseBeforeKeywords);
          if (matchedKw) {
            return this.formatResult(
              'paused',
              engine,
              engineSwitched,
              fallbackReason,
              `Action execution suspended before committing "${pauseAction}" on target "${targetLine || 'element'}" matching pause keyword "${matchedKw}"`,
              steps,
              finalPage,
              currentElements,
              {
                action: pauseAction,
                target: targetLine || (targetIndex !== undefined ? `[${targetIndex}]` : undefined),
                matchedKeyword: matchedKw,
              },
            );
          }
        }

        if (decision.shouldEscalate) {
          return this.formatResult(
            'escalate',
            engine,
            engineSwitched,
            fallbackReason,
            decision.reason || `Heuristic confidence < threshold or target ambiguous`,
            steps,
            finalPage,
            currentElements,
            undefined,
            undefined,
            params.goal,
          );
        }
      }

      if (actionToTake === 'click') {
        const selectedName = getPrimaryAccessibleName(targetLine);
        if (hasDuplicateClickableAccessibleName(targetLine, targetIndex, currentElements)) {
          return this.formatResult(
            'escalate',
            engine,
            engineSwitched,
            fallbackReason,
            `Click target has a duplicate/ambiguous accessible name: "${selectedName}"`,
            steps,
            finalPage,
            currentElements,
            undefined,
            undefined,
            params.goal,
          );
        }
      }

      // Step 3: Execute Action
      sendProgress(step, `${actionToTake} on ${targetLine || 'page'}`);

      let outcome = 'urlChanged:false, mutated:false';

      try {
        if (actionToTake === 'wait') {
          await new Promise((r) => setTimeout(r, 1000));
          outcome = 'urlChanged:false, mutated:false, waited:1000ms';
        } else if (actionToTake === 'scroll_down') {
          const scrollRes = await internalCaller('chrome_smart_scroll', {
            direction: 'down',
            tabId: params.tabId,
            sessionId: params.sessionId || params.sessionContext,
          });
          outcome = this.parseOutcome(scrollRes);
        } else if (actionToTake === 'scroll_up') {
          const scrollRes = await internalCaller('chrome_smart_scroll', {
            direction: 'up',
            tabId: params.tabId,
            sessionId: params.sessionId || params.sessionContext,
          });
          outcome = this.parseOutcome(scrollRes);
        } else if (actionToTake === 'back') {
          const navRes = await internalCaller('chrome_navigate', {
            url: 'back',
            action: 'back',
            tabId: params.tabId,
            sessionId: params.sessionId || params.sessionContext,
          });
          outcome = this.parseOutcome(navRes);
        } else if (actionToTake === 'click') {
          if (targetIndex === undefined) {
            return this.formatResult(
              'escalate',
              engine,
              engineSwitched,
              fallbackReason,
              'Click action selected but target index is undefined',
              steps,
              finalPage,
              currentElements,
            );
          }
          const clickRes = await internalCaller('chrome_interact_index', {
            action: 'click',
            index: targetIndex,
            tabId: params.tabId,
            includeDelta: true,
            sessionId: params.sessionId || params.sessionContext,
          });
          outcome = this.parseOutcome(clickRes);
        } else if (actionToTake === 'type') {
          if (targetIndex === undefined) {
            return this.formatResult(
              'escalate',
              engine,
              engineSwitched,
              fallbackReason,
              'Type action selected but target index is undefined',
              steps,
              finalPage,
              currentElements,
            );
          }
          const textPayload = extractTextPayload(params.goal, params.textHint);
          if (!textPayload) {
            return this.formatResult(
              'escalate',
              engine,
              engineSwitched,
              fallbackReason,
              'Text payload unclear from goal and textHint',
              steps,
              finalPage,
              currentElements,
            );
          }
          const fillRes = await internalCaller('chrome_fill_index', {
            index: targetIndex,
            text: textPayload,
            tabId: params.tabId,
            pressEnter: true,
            includeDelta: true,
            sessionId: params.sessionId || params.sessionContext,
          });
          outcome = this.parseOutcome(fillRes);
        } else if (actionToTake === 'select') {
          // Two-stage select (§2.3, §5.2, §5.3)
          if (targetIndex === undefined) {
            return this.formatResult(
              'escalate',
              engine,
              engineSwitched,
              fallbackReason,
              'Select action selected but target index is undefined',
              steps,
              finalPage,
              currentElements,
            );
          }
          const optionsRes = await internalCaller('chrome_get_dropdown_options', {
            index: targetIndex,
            tabId: params.tabId,
            sessionId: params.sessionId || params.sessionContext,
          });
          const optData = optionsRes?.content?.[0]?.text
            ? JSON.parse(optionsRes.content[0].text)
            : {};
          const options: Array<{ text: string; value: string }> = optData.options || [];

          if (options.length === 0) {
            return this.formatResult(
              'escalate',
              engine,
              engineSwitched,
              fallbackReason,
              `No dropdown options retrieved for element [${targetIndex}]`,
              steps,
              finalPage,
              currentElements,
            );
          }

          let selectedVal = options[0].value;
          // Heuristic option matching
          const goalLower = params.goal.toLowerCase();
          const matched = options.find(
            (o) =>
              goalLower.includes(o.text.toLowerCase()) || goalLower.includes(o.value.toLowerCase()),
          );
          if (matched) selectedVal = matched.value;

          const fillRes = await internalCaller('chrome_fill_index', {
            index: targetIndex,
            value: selectedVal,
            tabId: params.tabId,
            includeDelta: true,
            sessionId: params.sessionId || params.sessionContext,
          });
          outcome = this.parseOutcome(fillRes);
        }
      } catch (execErr: any) {
        outcome = `error:${execErr?.message || execErr}`;
      }

      // Step 4: Record Step
      const record: DecisionStep = {
        step,
        action: actionToTake,
        target: targetLine || (targetIndex ? `[${targetIndex}]` : 'page'),
        confidence: Math.round(confidence * 100) / 100,
        ...(suggestion ? { suggestion } : {}),
        outcome,
      };
      steps.push(record);

      if (outcome.startsWith('error:')) {
        return this.formatResult(
          'escalate',
          engine,
          engineSwitched,
          fallbackReason,
          `Native action was not retried after an uncertain result: ${outcome.slice(6)}`,
          steps,
          finalPage,
          currentElements,
          undefined,
          { tier: 'cloud_escalation', reason: outcome.slice(6), candidateCount: 0, elapsedMs: 0 },
          params.goal,
        );
      }

      // An interaction response without positive verification is not permission to
      // repeat it: the page may already have accepted the action.
      if (
        ['click', 'type', 'select'].includes(actionToTake) &&
        !outcome.includes('mutated:true') &&
        !outcome.includes('urlChanged:true')
      ) {
        return this.formatResult(
          'escalate',
          engine,
          engineSwitched,
          fallbackReason,
          `Action may have been applied but goal is unverified (${outcome})`,
          steps,
          finalPage,
          currentElements,
          undefined,
          localDecision
            ? {
                ...localDecision,
                reason: `${localDecision.reason}; action applied but goal unverified`,
              }
            : {
                tier: 'cloud_escalation',
                reason: 'Action applied but goal unverified',
                candidateCount: 0,
                elapsedMs: 0,
              },
          params.goal,
        );
      }

      if (
        localDecision?.tier === 'heuristic' &&
        isExplicitOneShotGoal(params.goal || '') &&
        ['click', 'type', 'select'].includes(actionToTake) &&
        outcome.startsWith('urlChanged:') &&
        outcome.split(', ').includes('mutated:true')
      ) {
        return this.formatResult(
          'done',
          engine,
          engineSwitched,
          fallbackReason,
          'Successful one-shot local action completed',
          steps,
          finalPage,
          currentElements,
          undefined,
          localDecision,
          params.goal,
        );
      }

      history.push({
        step,
        action: `${actionToTake} ${targetLine || ''}`.trim(),
        outcome,
      });
    }

    return this.formatResult(
      'max_steps',
      engine,
      engineSwitched,
      fallbackReason,
      `Reached maximum steps limit (${maxSteps})`,
      steps,
      finalPage,
      currentElements,
      undefined,
      localDecision,
    );
  }

  private parseOutcome(res: any): string {
    if (!res) return 'urlChanged:false, mutated:false';
    try {
      const data = typeof res === 'string' ? JSON.parse(res) : res;
      if (data.isError) {
        let errText = data.content?.[0]?.text || data.message || 'tool execution failed';
        if (typeof errText === 'string') {
          try {
            const p = JSON.parse(errText);
            errText = p.error || p.reason || p.message || p.detail || errText;
          } catch {}
        }
        return `error:${String(errText)
          .replace(/[\r\n]+/g, ' ')
          .slice(0, 150)}`;
      }
      const content = data.content?.[0]?.text;
      let parsed = data;
      if (content) {
        try {
          parsed = JSON.parse(content);
        } catch {
          if (typeof content === 'string') {
            if (
              /error|fail|invalid|cannot|unable|timed?\s*out|exception|not\s+found/i.test(content)
            ) {
              return `error:${content.replace(/[\r\n]+/g, ' ').slice(0, 150)}`;
            }
          }
        }
      }
      if (parsed.isError || parsed.success === false) {
        const errText =
          parsed.error || parsed.reason || parsed.message || parsed.detail || 'action failed';
        return `error:${String(errText)
          .replace(/[\r\n]+/g, ' ')
          .slice(0, 150)}`;
      }
      if (parsed.error && !parsed.success) {
        return `error:${String(parsed.error)
          .replace(/[\r\n]+/g, ' ')
          .slice(0, 150)}`;
      }

      const urlChanged = Boolean(parsed.urlChanged);
      let mutated: boolean | undefined =
        typeof parsed.mutated === 'boolean' ? parsed.mutated : undefined;
      let visualDiff: number | undefined = undefined;

      if (parsed.perceptiveDelta) {
        const perceptiveMutation = Boolean(
          parsed.perceptiveDelta.advanced ||
          parsed.perceptiveDelta.questionChanged ||
          parsed.perceptiveDelta.progressChanged ||
          parsed.perceptiveDelta.mutated,
        );
        if (perceptiveMutation) mutated = true;
        if (typeof parsed.perceptiveDelta.visualDiff === 'number') {
          visualDiff = parsed.perceptiveDelta.visualDiff;
        }
      }
      if (parsed.delta) {
        const deltaMutation =
          !parsed.delta.unchanged &&
          ((parsed.delta.added && parsed.delta.added.length > 0) ||
            (parsed.delta.modified && parsed.delta.modified.length > 0) ||
            (parsed.delta.removed && parsed.delta.removed.length > 0) ||
            (typeof parsed.delta.changedNodes === 'number' && parsed.delta.changedNodes > 0));
        if (deltaMutation) mutated = true;
        else if (mutated === undefined && parsed.delta.unchanged === true) mutated = false;
      }

      const parts = [
        `urlChanged:${urlChanged}`,
        `mutated:${mutated === undefined ? 'unknown' : mutated}`,
      ];
      if (visualDiff !== undefined) {
        parts.push(`visualDiff:${visualDiff.toFixed(2)}`);
      }
      return parts.join(', ');
    } catch {
      return 'urlChanged:false, mutated:false';
    }
  }

  private formatResult(
    status: ActTowardGoalStatus,
    engine: DecisionEngineType,
    engineSwitched: boolean,
    fallbackReason: FallbackReason,
    reason: string | undefined,
    steps: DecisionStep[],
    finalPage: PageState,
    currentElements: string[],
    pausedBeforeAction?: PausedBeforeAction,
    localDecision?: LocalDecisionDiagnostics,
    taskGoal?: string,
  ): ActTowardGoalResult {
    const isCloudEscalation = status === 'escalate';
    const knownSecrets = new Set<string>();
    for (const line of currentElements) {
      const sensitive =
        /password|passwd|passcode|secret|token|cc-number|cc-csc|cvc|cvv|security.?code|one.?time.?code|otp|data-sensitive/i.test(
          line,
        );
      if (!sensitive) continue;
      for (const match of line.matchAll(
        /\b(?:value|placeholder|aria-label|title)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
      )) {
        const value = match[1] ?? match[2] ?? match[3];
        if (value && value.length >= 3) knownSecrets.add(value);
      }
    }
    for (const rawUrl of [
      finalPage.url,
      ...currentElements.flatMap((line) =>
        [
          ...line.matchAll(
            /\b(?:href|action|src|formaction)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
          ),
        ].map((m) => m[1] ?? m[2] ?? m[3] ?? ''),
      ),
    ]) {
      try {
        const url = new URL(rawUrl, 'https://redaction.invalid');
        for (const [key, value] of url.searchParams)
          if (
            /token|auth|key|secret|password|pass|card|cvc|cvv|code|session/i.test(key) &&
            value.length >= 3
          )
            knownSecrets.add(value);
        if (url.hash.length > 1) knownSecrets.add(decodeURIComponent(url.hash.slice(1)));
      } catch {
        /* Malformed URLs are handled conservatively below. */
      }
    }
    const redactSecretText = (value: string): string => {
      let safe = value;
      for (const secret of [...knownSecrets].sort((a, b) => b.length - a.length)) {
        safe = safe.split(secret).join('[REDACTED]');
      }
      const redacted = safe
        .replace(/https?:\/\/[^\s"'<>]+/gi, (rawUrl) => {
          try {
            const url = new URL(rawUrl);
            for (const key of [...url.searchParams.keys()]) {
              if (/token|auth|key|secret|password|pass|card|cvc|cvv|code|session/i.test(key)) {
                url.searchParams.set(key, '[REDACTED]');
              }
            }
            if (url.hash) url.hash = '#[REDACTED]';
            return url.toString();
          } catch {
            return '[REDACTED_URL]';
          }
        })
        .replace(
          /\b((?:password|passwd|pass|token|access_token|auth|authorization|api[_-]?key|secret|card|cc[_-]?(?:number|num)|cvc|cvv|security[_-]?code))\b\s*[:=]\s*[^\s,;"'<>]+/gi,
          '$1=[REDACTED]',
        )
        .replace(/(\bhttps?:\/\/[^\s"'<>]*[?#])[^\s"'<>]*/gi, '$1[REDACTED]');
      return redactSensitiveLabeledValues(redacted);
    };
    const sanitizeText = (value: string): string =>
      redactCredentialAssignments(redactSecretText(value));
    const sanitizedPage: PageState = isCloudEscalation
      ? { ...finalPage, url: sanitizeText(finalPage.url).replace(/[?#].*$/, '') }
      : finalPage;
    const sanitizedElements = isCloudEscalation
      ? currentElements.map((line) => {
          const prefix =
            line.match(/^(\[\d+(?:\|[^\]]+)?\](?:\s*\[[^\]]+\])*\s+[a-z]+)/i)?.[1] || '';
          const roleName = line.match(
            /^\[\d+(?:\|[^\]]+)?\](?:\s*\[[^\]]+\])*\s+[a-z]+\s+(?:"([^"]*)"|'([^']*)')/i,
          );
          const metadata =
            line
              .match(
                /\b(?:autocomplete|name|data-sensitive|sensitive)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
              )
              ?.join(' ') || '';
          const sensitiveLabel = roleName?.[1] ?? roleName?.[2] ?? '';
          const isSensitiveType =
            /\btype\s*=\s*(?:"password"|'password'|password|"hidden"|'hidden'|hidden)/i.test(line);
          const isSensitiveMetadata =
            /(?:cc-number|cc-csc|cc-exp|cvc|cvv|security.?code|data-sensitive\s*=\s*(?:"true"|'true'|true))/i.test(
              metadata,
            );
          const isSensitiveLabel =
            /password|passwd|passcode|secret|token|credit.?card|card.?number|cc.?number|cvc|cvv|security.?code|one.?time.?code|otp/i.test(
              sensitiveLabel,
            );
          const sensitiveControl = isSensitiveType || isSensitiveMetadata || isSensitiveLabel;
          if (sensitiveControl) return `${prefix} [sensitive control omitted]`;
          let safe = line.replace(
            /\b([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g,
            (match, name: string, doubleValue: string, singleValue: string, bareValue: string) => {
              const val = doubleValue ?? singleValue ?? bareValue ?? '';
              if (/^(?:href|action|src|formaction)$/i.test(name))
                return `${name}="${redactSecretText(val)}"`;
              if (
                /^(?:value|placeholder|autocomplete|data-[\w-]+|title|aria-label|name)$/i.test(name)
              )
                return `${name}="[REDACTED]"`;
              return match;
            },
          );
          safe = sanitizeText(safe);
          return safe;
        })
      : currentElements;
    const sanitizedReason = isCloudEscalation ? sanitizeText(reason || '') : reason;
    const sanitizedSteps = isCloudEscalation
      ? steps.map((item) => ({
          ...item,
          target: sanitizeText(item.target),
          outcome: sanitizeText(item.outcome),
        }))
      : steps;
    const typingIntent = /\b(?:type|fill|enter|input|paste)\b/i.test(taskGoal || '');
    const sanitizedGoal = isCloudEscalation
      ? typingIntent
        ? sanitizeText((taskGoal || '').replace(/(["'])[^"']*\1/g, '$1[REDACTED]$1')).slice(0, 500)
        : sanitizeText(taskGoal || '').slice(0, 500)
      : taskGoal;
    const sanitizedDecision =
      isCloudEscalation && localDecision
        ? { ...localDecision, reason: sanitizeText(localDecision.reason) }
        : localDecision;
    const sanitizedPaused =
      isCloudEscalation && pausedBeforeAction
        ? {
            action: pausedBeforeAction.action,
            ...(pausedBeforeAction.target
              ? { target: sanitizeText(pausedBeforeAction.target) }
              : {}),
            matchedKeyword: '[REDACTED]',
          }
        : pausedBeforeAction;
    const rankedElements = isCloudEscalation
      ? sanitizedElements
          .map((line, order) => ({
            line,
            order,
            actionable:
              /^\[\d+(?:\|[^\]]+)?\](?:\s*\[[^\]]+\])*\s*(?:button|link|checkbox|radio|tab|menuitem|switch|option|textbox|searchbox|combobox|select)\b/i.test(
                line,
              ),
          }))
          .sort((a, b) => Number(b.actionable) - Number(a.actionable) || a.order - b.order)
          .map(({ line }) => line)
      : sanitizedElements;
    const keptElements = rankedElements.slice(0, 100);
    const omittedElementCount = Math.max(0, currentElements.length - keptElements.length);
    return {
      status,
      engine,
      engineSwitched,
      fallbackReason,
      ...(isCloudEscalation ? { reason: sanitizedReason } : reason ? { reason } : {}),
      ...(sanitizedPaused ? { pausedBeforeAction: sanitizedPaused } : {}),
      ...(sanitizedDecision ? { localDecision: sanitizedDecision } : {}),
      ...(isCloudEscalation
        ? {
            cloudContext: {
              goal: sanitizedGoal || '',
              page: sanitizedPage,
              omittedElementCount,
              requestFullDomWhenNeeded: true as const,
            },
          }
        : {}),
      steps: sanitizedSteps,
      finalPage: sanitizedPage,
      ...(status === 'escalate' || status === 'stuck' || status === 'paused'
        ? { currentElements: keptElements }
        : {}),
    };
  }
}
