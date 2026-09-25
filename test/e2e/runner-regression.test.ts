import assert from 'node:assert/strict';
import test from 'node:test';
import { runTier } from './runner.ts';

test('runTier fails when its file pattern matches no test files', async () => {
  const result = await runTier({
    id: 'EMPTY',
    name: 'Empty regression suite',
    pattern: 'test/e2e/__missing__/*.test.ts',
    targetCount: 0,
  });

  assert.equal(result.success, false);
  assert.equal(result.passed, 0);
  assert.equal(result.failed, 1);
});
