import type { LocalDecisionMode, LocalDecisionTier } from './types';

export type SafetyCondition = 'safe' | 'ambiguous' | 'unsafe';

/** Returns permitted decision tiers in order; safety is never bypassed. */
export function getPermittedNextTiers(
  mode: LocalDecisionMode,
  condition: SafetyCondition,
): LocalDecisionTier[] {
  if (condition === 'unsafe') return ['safety', 'cloud_escalation'];

  switch (mode) {
    case 'disabled':
      return ['cloud_escalation'];
    case 'heuristic_only':
      return ['heuristic', 'cloud_escalation'];
    case 'auto':
      return ['heuristic', 'cloud_escalation'];
  }
}
