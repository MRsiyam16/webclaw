/**
 * Browser decision-loop types.
 * Contracts for deterministic actions and escalation to the calling AI agent.
 */

export interface PageState {
  url: string;
  title: string;
}

export interface ActionHistoryItem {
  step: number;
  action: string;
  outcome: string;
}

export interface DecisionState {
  task: string;
  page: PageState;
  elements: string[];
  history: ActionHistoryItem[];
  pending_modal?: string;
}

export type BrowserActionType =
  'click' | 'type' | 'select' | 'scroll_down' | 'scroll_up' | 'back' | 'wait' | 'done' | 'escalate';

export interface DecisionStep {
  step: number;
  action: string;
  target: string;
  confidence: number;

  outcome: string;
}

export type DecisionEngineType = 'heuristic';

export type ActTowardGoalStatus =
  'done' | 'escalate' | 'stuck' | 'blocked' | 'max_steps' | 'timeout' | 'paused';

export interface PausedBeforeAction {
  action: string;
  target?: string;
  matchedKeyword: string;
}

export type FallbackReason =
  'no_api_key' | 'invalid_key' | 'quota_exhausted' | 'rate_limited' | 'network_error' | null;

export interface ActTowardGoalParams {
  goal: string;
  tabId?: number;
  maxSteps?: number;
  timeoutMs?: number;
  textHint?: string;
  confidenceThreshold?: number;
  pauseBeforeKeywords?: string[];
  sessionId?: string;
  sessionContext?: string;
  _meta?: {
    progressToken?: string | number;
    [key: string]: any;
  };
}

export type LocalDecisionMode = 'disabled' | 'heuristic_only' | 'auto';

export type LocalDecisionTier = 'safety' | 'heuristic' | 'cloud_escalation';

export interface LocalDecisionDiagnostics {
  tier: LocalDecisionTier;
  reason: string;
  candidateCount: number;
  elapsedMs: number;
}

export interface ActTowardGoalResult {
  status: ActTowardGoalStatus;
  engine: DecisionEngineType;
  engineSwitched: boolean;
  fallbackReason: FallbackReason;
  reason?: string;
  pausedBeforeAction?: PausedBeforeAction;
  steps: DecisionStep[];
  finalPage: PageState;
  currentElements?: string[];

  cloudContext?: {
    goal: string;
    page: PageState;
    omittedElementCount: number;
    requestFullDomWhenNeeded: true;
  };

  localDecision?: LocalDecisionDiagnostics;
}
