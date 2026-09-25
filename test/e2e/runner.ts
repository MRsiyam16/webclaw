/**
 * Master E2E Test Suite Runner
 * Runs Tier 1 (Coverage), Tier 2 (Boundary), Tier 3 (Pairwise), Tier 4 (Workflows)
 * Generates structured rollup report and enforces zero-regression exit codes.
 */

import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '../../');

export interface TierConfig {
  id: string;
  name: string;
  pattern: string;
  targetCount: number;
}

const TIERS: TierConfig[] = [
  {
    id: 'T1',
    name: 'Tier 1: Feature Coverage (F01 - F13)',
    pattern: 'test/e2e/tier1-feature-coverage/*.test.ts',
    targetCount: 65,
  },
  {
    id: 'T2',
    name: 'Tier 2: Boundary & Corner Cases (F01 - F13)',
    pattern: 'test/e2e/tier2-boundary-corner/*.test.ts',
    targetCount: 65,
  },
  {
    id: 'T3',
    name: 'Tier 3: Cross-Feature Pairwise Combinations',
    pattern: 'test/e2e/tier3-pairwise-combinations/*.test.ts',
    targetCount: 16,
  },
  {
    id: 'T4',
    name: 'Tier 4: Real-World Application Workflows',
    pattern: 'test/e2e/tier4-real-world-scenarios/*.test.ts',
    targetCount: 5,
  },
];

export async function runTier(tier: TierConfig): Promise<{
  id: string;
  name: string;
  passed: number;
  failed: number;
  durationMs: number;
  success: boolean;
}> {
  const [relativeDir, patternName] = tier.pattern.split(/[/\\](?=[^/\\]+$)/);
  const filePattern = new RegExp(
    `^${patternName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('\\*', '.*')}$`,
  );
  let testFiles: string[];
  try {
    const entries = await readdir(path.resolve(rootDir, relativeDir), { withFileTypes: true });
    testFiles = entries
      .filter((entry) => entry.isFile() && filePattern.test(entry.name))
      .map((entry) => path.join(relativeDir, entry.name));
  } catch {
    testFiles = [];
  }

  if (testFiles.length === 0) {
    return {
      id: tier.id,
      name: tier.name,
      passed: 0,
      failed: 1,
      durationMs: 0,
      success: false,
    };
  }

  return new Promise((resolve) => {
    const startTime = Date.now();
    let stdout = '';
    let stderr = '';

    const args = ['--experimental-strip-types', '--test', ...testFiles];

    const child = spawn(process.execPath, args, {
      cwd: rootDir,
      shell: false,
      env: { ...process.env, NODE_ENV: 'test' },
    });

    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });

    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    child.on('close', (code) => {
      const durationMs = Date.now() - startTime;
      let passed = 0;
      let failed = 0;

      // Parse TAP or test output summary
      const passMatch = stdout.match(/(?:#|ℹ) pass (\d+)/);
      const failMatch = stdout.match(/(?:#|ℹ) fail (\d+)/);

      if (passMatch) passed = Number.parseInt(passMatch[1], 10);
      if (failMatch) failed = Number.parseInt(failMatch[1], 10);

      // Fallback count based on ok / not ok lines if summary missing
      if (!passMatch && !failMatch) {
        const okMatches = stdout.match(/^\s*ok\s+\d+/gm);
        const notOkMatches = stdout.match(/^\s*not ok\s+\d+/gm);
        passed = okMatches ? okMatches.length : 0;
        failed = notOkMatches ? notOkMatches.length : 0;
      }

      const executed = passed + failed;
      if (executed === 0) failed = 1;
      const success = code === 0 && failed === 0 && executed > 0;

      if (!success) {
        console.error(`\n--- ${tier.name} Output on Failure ---`);
        console.error(stdout);
        if (stderr) console.error(stderr);
      }

      resolve({
        id: tier.id,
        name: tier.name,
        passed,
        failed,
        durationMs,
        success,
      });
    });
  });
}

async function main() {
  console.log('================================================================');
  console.log('  MCP-CHROME MODERNIZATION & BROWSER-USE E2E TEST RUNNER');
  console.log('================================================================\n');

  let totalPassed = 0;
  let totalFailed = 0;
  let hasFailure = false;
  const startTime = Date.now();
  const results = [];

  for (const tier of TIERS) {
    process.stdout.write(`Executing ${tier.name}... `);
    const res = await runTier(tier);
    results.push(res);
    totalPassed += res.passed;
    totalFailed += res.failed;

    if (res.success) {
      console.log(`PASS (${res.passed} tests, ${res.durationMs}ms)`);
    } else {
      console.log(`FAIL (${res.failed} failed, ${res.passed} passed, ${res.durationMs}ms)`);
      hasFailure = true;
    }
  }

  const totalDuration = Date.now() - startTime;

  console.log('\n================================================================');
  console.log('  E2E TEST EXECUTION SUMMARY');
  console.log('================================================================');
  for (const r of results) {
    const status = r.success ? '[OK]  ' : '[FAIL]';
    console.log(
      `  ${status} ${r.id.padEnd(4)}: ${r.name.padEnd(46)} | Passed: ${String(r.passed).padStart(3)} | Failed: ${String(r.failed).padStart(2)} | Time: ${String(r.durationMs).padStart(5)}ms`,
    );
  }
  console.log('----------------------------------------------------------------');
  console.log(
    `  Total Suites: ${results.length} | Total Passed: ${totalPassed} | Total Failed: ${totalFailed} | Time: ${totalDuration}ms`,
  );
  console.log('================================================================\n');

  if (hasFailure) {
    console.error('FAILED: One or more test suites did not pass.');
    process.exit(1);
  } else {
    console.log('SUCCESS: All test suites passed with 100% compliance.');
    process.exit(0);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error('Fatal Runner Exception:', err);
    process.exit(1);
  });
}
