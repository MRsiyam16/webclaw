import { describe, expect, test } from '@jest/globals';
import { getPermittedNextTiers } from './local-decision-policy';

describe('getPermittedNextTiers', () => {
  test('auto tries heuristic then escalates to cloud', () => {
    expect(getPermittedNextTiers('auto', 'ambiguous')).toEqual(['heuristic', 'cloud_escalation']);
  });

  test('safety condition prevents local tiers in every mode', () => {
    for (const mode of ['disabled', 'heuristic_only', 'auto'] as const) {
      expect(getPermittedNextTiers(mode, 'unsafe')).toEqual(['safety', 'cloud_escalation']);
    }
  });

  test('disabled only permits cloud escalation after safety clears', () => {
    expect(getPermittedNextTiers('disabled', 'safe')).toEqual(['cloud_escalation']);
  });

  test('heuristic_only never permits LocalModel', () => {
    expect(getPermittedNextTiers('heuristic_only', 'ambiguous')).toEqual([
      'heuristic',
      'cloud_escalation',
    ]);
  });
});
