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
