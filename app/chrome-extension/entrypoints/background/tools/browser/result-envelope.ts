export type Verdict = 'applied' | 'applied_unverified' | 'noop' | 'failed' | 'stale_ref';

export interface PageDelta {
  changedNodes: number;
  [k: string]: unknown;
}
export interface IndexedElement {
  ref: string;
  [k: string]: unknown;
}

export interface ActionEvidence {
  committed?: boolean;
  method?: 'cdp_native' | 'cdp_key_by_key' | 'synthetic_inpage' | 'widget_native';
  isTrusted?: boolean;
  urlChanged: boolean;
  previousUrl: string;
  currentUrl: string;
  delta?: PageDelta;
  perceptiveDelta?: { advanced: boolean; questionChanged: boolean; progressChanged: boolean };
  deliveryVerified?: boolean;
}

export type PostConditionKind =
  | 'value_equals'
  | 'element_exists'
  | 'text_present'
  | 'url_matches'
  | 'list_count_delta'
  | 'element_state';

export interface PostConditionResult {
  condition: PostConditionKind;
  expected: unknown;
  actual: unknown;
  passed: boolean;
  evidence: unknown;
}

export interface PostConditionSpec {
  condition: PostConditionKind;
  expected: unknown;
}

/** Context the tool wires in after acting; each condition derives its `actual` from one field. */
export interface PostConditionContext {
  readBackValue?: string;
  url?: string;
  elementExists?: boolean;
  pageText?: string;
  listCountBefore?: number;
  listCountAfter?: number;
  elementState?: string;
}

const jsonEqual = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Evaluate post-action conditions, returning one auditable result per spec.
 * Pass rule: JSON.stringify equality, EXCEPT text_present (substring `include`)
 * and url_matches (/regex/ literal -> RegExp.test, otherwise exact string equality).
 */
export function evaluatePostConditions(
  specs: PostConditionSpec[],
  ctx: PostConditionContext,
): PostConditionResult[] {
  return (specs || []).map((spec): PostConditionResult => {
    switch (spec.condition) {
      case 'value_equals': {
        const actual = typeof ctx.readBackValue === 'string' ? ctx.readBackValue : undefined;
        return {
          condition: spec.condition,
          expected: spec.expected,
          actual: actual ?? null,
          passed: jsonEqual(spec.expected, actual),
          evidence: { readBackValue: actual ?? null },
        };
      }
      case 'element_exists': {
        const actual = typeof ctx.elementExists === 'boolean' ? ctx.elementExists : undefined;
        return {
          condition: spec.condition,
          expected: spec.expected,
          actual: actual ?? null,
          passed: jsonEqual(spec.expected, actual),
          evidence: { elementExists: actual ?? null },
        };
      }
      case 'text_present': {
        // include semantics: passed = pageText contains expected (never prose alone).
        const haystack = typeof ctx.pageText === 'string' ? ctx.pageText : '';
        const needle =
          typeof spec.expected === 'string' ? spec.expected : JSON.stringify(spec.expected);
        const idx = needle.length > 0 ? haystack.indexOf(needle) : -1;
        const passed = idx >= 0;
        const evidence = passed
          ? haystack.slice(Math.max(0, idx - 40), idx + needle.length + 40)
          : haystack.slice(0, 200);
        return {
          condition: spec.condition,
          expected: spec.expected,
          actual: passed,
          passed,
          evidence,
        };
      }
      case 'url_matches': {
        const url = typeof ctx.url === 'string' ? ctx.url : '';
        const exp = typeof spec.expected === 'string' ? spec.expected : '';
        const regexLiteral = /^\/(.+)\/([a-z]*)$/i.exec(exp);
        let passed: boolean;
        let rule: 'exact' | 'regex';
        if (regexLiteral) {
          rule = 'regex';
          try {
            passed = new RegExp(regexLiteral[1], regexLiteral[2]).test(url);
          } catch {
            passed = false;
          }
        } else {
          rule = 'exact';
          passed = jsonEqual(spec.expected, ctx.url);
        }
        return {
          condition: spec.condition,
          expected: spec.expected,
          actual: url || null,
          passed,
          evidence: { url: url || null, rule },
        };
      }
      case 'list_count_delta': {
        const hasCounts =
          typeof ctx.listCountBefore === 'number' && typeof ctx.listCountAfter === 'number';
        const delta = hasCounts
          ? (ctx.listCountAfter as number) - (ctx.listCountBefore as number)
          : undefined;
        return {
          condition: spec.condition,
          expected: spec.expected,
          actual: hasCounts ? delta : null,
          passed: hasCounts && jsonEqual(spec.expected, delta),
          evidence: {
            listCountBefore: ctx.listCountBefore ?? null,
            listCountAfter: ctx.listCountAfter ?? null,
            delta: hasCounts ? delta : null,
          },
        };
      }
      case 'element_state': {
        const actual = typeof ctx.elementState === 'string' ? ctx.elementState : undefined;
        return {
          condition: spec.condition,
          expected: spec.expected,
          actual: actual ?? null,
          passed: jsonEqual(spec.expected, actual),
          evidence: { elementState: actual ?? null },
        };
      }
      default:
        return {
          condition: spec.condition,
          expected: spec.expected,
          actual: null,
          passed: false,
          evidence: null,
        };
    }
  });
}

export interface ActionResult<T = unknown> {
  verdict: Verdict;
  outcome: string;
  evidence: ActionEvidence;
  postConditions: PostConditionResult[];
  data?: T;
  recovery?: {
    code: 'stale_ref' | 'occluded' | 'detached' | 'throttled';
    message: string;
    freshRefs: IndexedElement[];
  };
}

export function postCondition(
  condition: PostConditionResult['condition'],
  expected: unknown,
  actual: unknown,
  evidence: unknown = null,
): PostConditionResult {
  return {
    condition,
    expected,
    actual,
    passed: JSON.stringify(expected) === JSON.stringify(actual),
    evidence,
  };
}

/**
 * Build the stale_ref envelope for a ref/index whose node was replaced.
 *
 * Keeps every legacy field the tool response already had (Hyrum's Law) and ADDS
 * verdict/outcome/recovery. `recovery.freshRefs` is the page's CURRENT indexed
 * element list, so the caller can retry immediately without a fresh read_dom.
 */
export function buildStaleRefResult(input: {
  index: number | string;
  message: string;
  freshRefs: IndexedElement[];
  evidence?: Partial<ActionEvidence>;
}): ActionResult {
  const evidence: ActionEvidence = {
    urlChanged: false,
    previousUrl: '',
    currentUrl: '',
    ...(input.evidence || {}),
  };
  const message = input.message || `ref/index [${input.index}] is stale`;
  return buildResult({
    evidence,
    postConditions: [],
    recovery: {
      code: 'stale_ref',
      message,
      freshRefs: Array.isArray(input.freshRefs) ? input.freshRefs : [],
    },
  });
}

export function buildResult(input: {
  evidence: ActionEvidence;
  postConditions: PostConditionResult[];
  data?: unknown;
  recovery?: ActionResult['recovery'];
}): ActionResult {
  const { evidence, postConditions, data, recovery } = input;
  const failedCond = postConditions.find((p) => !p.passed);
  const changed =
    evidence.urlChanged ||
    (evidence.delta?.changedNodes ?? 0) > 0 ||
    evidence.perceptiveDelta?.advanced === true ||
    evidence.perceptiveDelta?.questionChanged === true ||
    evidence.perceptiveDelta?.progressChanged === true ||
    evidence.committed === true;

  let verdict: Verdict = changed ? 'applied' : 'noop';
  if (failedCond) verdict = 'failed';
  if (recovery?.code === 'stale_ref') verdict = 'stale_ref';

  const outcome = failedCond
    ? `${failedCond.condition} failed: expected ${JSON.stringify(failedCond.expected)}, got ${JSON.stringify(failedCond.actual)}`
    : verdict === 'noop'
      ? 'no change detected'
      : verdict === 'stale_ref'
        ? `stale ref: ${recovery?.message}`
        : 'change detected';

  return { verdict, outcome, evidence, postConditions, data, recovery };
}
