#!/usr/bin/env node
// Live, tool-only benchmark. JSONL contains only synthetic case labels and measurements.
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';

const ROOT = resolve(import.meta.dirname, '../..');
const FIXTURE = join(ROOT, 'test', 'bench', 'fixtures', 'index.html');
let OUTPUT = process.env.WEBCLAW_BENCH_OUT || join(process.env.TMPDIR || process.env.TEMP || process.env.TMP || '.', 'webclaw-bench', `run-${new Date().toISOString().replaceAll(':', '-')}.jsonl`);
const BASE = process.env.CHROME_MCP_BASE || 'http://127.0.0.1:12306';
const browserId = 'chrome';
let sessionId;
let rpcId = 1;
let callCount = 0;

export const expectedRows = Array.from({ length: 40 }, (_, n) => ({
  id: `R${String(n + 1).padStart(3, '0')}`,
  name: `Synthetic ${String(n + 1).padStart(2, '0')}`,
  region: ['north', 'south', 'east', 'west'][n % 4],
  score: 1001 + n,
  status: n % 2 ? 'queued' : 'active',
}));
export const extractSchema = {
  type: 'array', items: { type: 'object', properties: {
    id: { type: 'string' }, name: { type: 'string' }, region: { type: 'string' }, score: { type: 'integer' }, status: { type: 'string' },
  }, required: ['id', 'name', 'region', 'score', 'status'] },
};

export function validateRows(result, expected = expectedRows) {
  assert.ok(result && result.data && Array.isArray(result.data.items), 'extract response must contain data.items');
  assert.deepEqual(result.data.items, expected, 'every row and every requested column must exactly match ground truth');
  assert.deepEqual(result.missing, [], 'no requested values may be missing');
  assert.ok(result.sourceRefs && typeof result.sourceRefs === 'object', 'sourceRefs must be present');
  for (let row = 0; row < expected.length; row++) {
    for (const key of Object.keys(expected[row])) {
      assert.match(result.sourceRefs[`items[${row}].${key}`] || '', /^e\d+$/, `missing valid source ref for items[${row}].${key}`);
    }
  }
  return { rows: expected.length, cells: expected.length * 5, refs: expected.length * 5, missing: 0 };
}

function selfTest() {
  const refs = Object.fromEntries(expectedRows.flatMap((row, i) => Object.keys(row).map(k => [`items[${i}].${k}`, `e${i * 5 + Object.keys(row).indexOf(k) + 1}`])));
  const good = { data: { items: expectedRows }, sourceRefs: refs, missing: [] };
  assert.deepEqual(validateRows(good), { rows: 40, cells: 200, refs: 200, missing: 0 });
  assert.throws(() => validateRows({ ...good, data: { items: expectedRows.slice(0, -1) } }), /exactly match ground truth/);
  assert.throws(() => validateRows({ ...good, missing: ['items[0].score'] }), /no requested values may be missing/);
  const failure = { isError: true, error: 'navigation_failed' };
  assert.throws(() => assert.equal(failure.success, true, 'failed navigation must not be accepted as success'));
  assert.throws(() => validateRows({ data: { items: expectedRows }, sourceRefs: {}, missing: [] }), /source ref/);
  console.log('oracle self-test passed: 4 adversarial failure checks rejected; no browser calls made');
}

async function rpc(method, params) {
  const tokenPath = join(process.env.USERPROFILE || homedir(), '.chrome-mcp', 'bridge-token');
  const token = (await readFile(tokenPath, 'utf8')).trim();
  const started = performance.now();
  const response = await fetch(`${BASE}/mcp`, {
    method: 'POST', headers: {
      'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      'x-mcp-token': token, ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    }, body: JSON.stringify({ jsonrpc: '2.0', ...(method === 'notifications/initialized' ? {} : { id: rpcId++ }), method, params }),
  });
  sessionId = response.headers.get('mcp-session-id') || sessionId;
  const body = await response.text();
  const elapsedMs = performance.now() - started;
  if (method === 'notifications/initialized' && response.ok) return { result: null, elapsedMs, responseChars: body.length, responseBytes: Buffer.byteLength(body) };
  if (!response.ok) throw new Error(`bridge_http_${response.status}`);
  const msg = body.split(/\r?\n/).filter(x => x.startsWith('data: ')).map(x => JSON.parse(x.slice(6))).at(-1) || JSON.parse(body);
  if (msg.error) throw new Error(`mcp_${msg.error.code ?? 'error'}`);
  return { result: msg.result, elapsedMs, responseChars: body.length, responseBytes: Buffer.byteLength(body) };
}

async function tool(name, args, tabId, iteration, phase, scenario = 'A_two_page_40_rows') {
  const { result, elapsedMs, responseChars, responseBytes } = await rpc('tools/call', { name, arguments: { ...args, browserId, tabId } });
  callCount++;
  const error = Boolean(result?.isError || result?.structuredContent?.isError);
  await appendFile(OUTPUT, `${JSON.stringify({ kind: 'request', scenario, phase, iteration, category: name, elapsedMs, responseChars, responseBytes, success: !error })}\n`);
  if (error) throw new Error(`${name}_reported_error`);
  const content = result?.content?.filter(c => c.type === 'text').at(-1)?.text;
  if (!content) return result?.structuredContent ?? result;
  try { return JSON.parse(content); } catch { return result?.structuredContent ?? { error: 'unparseable_tool_result' }; }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) return selfTest();
  if (args.includes('--probe-broken-oracle')) return validateRows({ data: { items: expectedRows.slice(0, -1) }, sourceRefs: {}, missing: [] });
  if (args.includes('--help') || args.length === 0) {
    console.log('Usage: node test/bench/web-task-speed.mjs --tab-id <owned-tab-id> [--warm 5] [--diagnose-batch] [--out <scratch.jsonl>]');
    console.log('Requires an agent-owned visible Chrome tab, bridge token, and local bridge. Cold browser samples are not supported.');
    return;
  }
  const value = flag => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; };
  const tabId = Number(value('--tab-id'));
  assert.ok(Number.isSafeInteger(tabId) && tabId > 0, '--tab-id must identify the agent-owned fixture tab');
  const warmCount = Number(value('--warm') || 5);
  assert.ok(Number.isInteger(warmCount) && warmCount >= 5, 'use at least five warm repetitions');
  const out = value('--out'); if (out) OUTPUT = resolve(out);
  await mkdir(resolve(OUTPUT, '..'), { recursive: true });
  await writeFile(OUTPUT, '');
  const handshakeStart = performance.now();
  const init = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'webclaw-bench', version: '0.1' } });
  sessionId = init.result?.sessionId || sessionId;
  await rpc('notifications/initialized', {});
  const setupMs = performance.now() - handshakeStart;
  await appendFile(OUTPUT, `${JSON.stringify({ kind: 'setup', scenario: 'A_two_page_40_rows', browserId, setupMs, tabIdProvided: true })}\n`);
  const fixture = pathToFileURL(FIXTURE).href;
  if (args.includes('--diagnose-batch')) {
    for (let iteration = 1; iteration <= warmCount; iteration++) {
      await tool('chrome_navigate', { url: `${fixture}?page=1`, background: true }, tabId, iteration, 'warm', 'diagnostic');
      const stages = [
        ['fill', { type: 'fill', selector: '#note', text: 'speed-check' }],
        ['click', { type: 'click', selector: '#synthetic-form button' }],
        ['assert', { type: 'assert', selector: '#form-result', condition: 'equals', expectedText: 'accepted:speed-check', timeoutMs: 1500 }],
        ['extract', { type: 'extract', selector: '#form-result', property: 'text', variableName: 'result' }],
      ];
      for (const [stage, action] of stages) {
        const out = await tool('chrome_batch_actions', { actions: [action] }, tabId, iteration, 'warm', `diagnostic_${stage}`);
        assert.equal(out.success, true, `${stage} failed`);
        if (stage === 'extract') assert.equal(out.extractedData?.result, 'accepted:speed-check');
      }
    }
    console.log(JSON.stringify({ output: OUTPUT, diagnosticRepetitions: warmCount, stages: ['fill', 'click', 'assert', 'extract'], note: 'four separate batch calls diagnose overhead; not comparable to the two-call workflow' }));
    return;
  }
  const fullStart = performance.now();
  let all = [];
  for (let page = 1; page <= 2; page++) {
    const nav = await tool('chrome_navigate', { url: `${fixture}?page=${page}`, background: true }, tabId, 0, 'warm');
    if (nav?.success === false || nav?.isError) throw new Error('navigation_failed');
    const extracted = await tool('chrome_extract', { schema: extractSchema, selector: '#records tbody tr' }, tabId, 0, 'warm');
    validateRows(extracted, expectedRows.slice((page - 1) * 20, page * 20));
    all = all.concat(extracted.data.items);
  }
  assert.deepEqual(all, expectedRows, 'complete two-page answer mismatch');
  const initialMs = performance.now() - fullStart;
  await appendFile(OUTPUT, `${JSON.stringify({ kind: 'workflow', scenario: 'A_two_page_40_rows', phase: 'initial', iteration: 0, wallClockMs: initialMs, calls: callCount, oracle: { rows: 40, columns: ['id', 'name', 'region', 'score', 'status'], cells: 200, missing: 0, perPageSourceRefsValidated: true } })}\n`);
  const samples = [];
  for (let iteration = 1; iteration <= warmCount; iteration++) {
    const start = performance.now(); let rows = [];
    for (let page = 1; page <= 2; page++) {
      const nav = await tool('chrome_navigate', { url: `${fixture}?page=${page}`, background: true }, tabId, iteration, 'warm');
      if (nav?.success === false || nav?.isError) throw new Error('navigation_failed');
      const extracted = await tool('chrome_extract', { schema: extractSchema, selector: '#records tbody tr' }, tabId, iteration, 'warm');
      validateRows(extracted, expectedRows.slice((page - 1) * 20, page * 20)); rows.push(...extracted.data.items);
    }
    assert.deepEqual(rows, expectedRows, 'complete two-page answer mismatch');
    const wallClockMs = performance.now() - start; samples.push(wallClockMs);
    await appendFile(OUTPUT, `${JSON.stringify({ kind: 'workflow', scenario: 'A_two_page_40_rows', phase: 'warm', iteration, wallClockMs, calls: 4, oracle: { rows: 40, columns: 5, cells: 200, missing: 0, sourceRefsValidated: true } })}\n`);
  }
  const scenarios = [{ name: 'A_two_page_40_rows', samples, calls: 4, oracle: '40 exact rows, 200 cells and 200 sourceRefs' }];
  for (const scenario of ['B_scoped_dom', 'C_delayed_form', 'C_fixed_wait', 'D_missing_and_navigation_failure']) {
    const timings = [];
    for (let iteration = 1; iteration <= warmCount; iteration++) {
      const start = performance.now();
      const navigate = await tool('chrome_navigate', { url: `${fixture}?page=1`, background: true }, tabId, iteration, 'warm', scenario);
      assert.equal(navigate.success, true, `fixture navigation failed: ${scenario}`);
      if (scenario === 'B_scoped_dom') {
        const full = await tool('chrome_read_dom', { deltaOnly: false, limit: 300 }, tabId, iteration, 'warm', scenario);
        const scoped = await tool('chrome_read_dom', { selector: '#form-region', deltaOnly: false }, tabId, iteration, 'warm', scenario);
        assert.ok(full.treeString?.includes('Form'), 'full read omitted form');
        assert.ok(scoped.selectorMatched && scoped.treeString?.includes('Note'), 'scoped read omitted form');
        assert.ok(!scoped.treeString.includes('R001'), 'scoped read leaked table rows');
      } else if (scenario === 'C_delayed_form' || scenario === 'C_fixed_wait') {
        const result = await tool('chrome_batch_actions', { actions: [
          { type: 'fill', selector: '#note', text: 'speed-check' },
          { type: 'click', selector: '#synthetic-form button' },
          ...(scenario === 'C_delayed_form'
            ? [{ type: 'assert', selector: '#form-result', condition: 'equals', expectedText: 'accepted:speed-check', timeoutMs: 1500 }]
            : [{ type: 'wait', durationMs: 500 }]),
          { type: 'extract', selector: '#form-result', property: 'text', variableName: 'result' },
        ] }, tabId, iteration, 'warm', scenario);
        assert.equal(result.success, true, 'form batch failed');
        if (scenario === 'C_delayed_form') assert.equal(result.assertions?.[0]?.passed, true, 'form postcondition failed');
        assert.equal(result.extractedData?.result, 'accepted:speed-check', 'form extraction wrong');
      } else {
        const extracted = await tool('chrome_extract', { schema: { type: 'object', properties: { known: { type: 'string' }, absent: { type: 'string' } }, required: ['known', 'absent'] }, selector: '#missing-region' }, tabId, iteration, 'warm', scenario);
        assert.deepEqual(extracted.data, { known: 'present' });
        assert.deepEqual(extracted.missing, ['absent']);
        assert.match(extracted.sourceRefs?.known || '', /^e\d+$/);
        const failure = await rpc('tools/call', { name: 'chrome_navigate', arguments: { url: `${pathToFileURL(join(ROOT, 'test', 'bench', 'fixtures', 'absent-404.html')).href}`, browserId, tabId, background: true, autoGroup: false } });
        const navText = failure.result?.content?.filter(c => c.type === 'text').at(-1)?.text;
        const nav = JSON.parse(navText || '{}');
        const rejected = failure.result?.isError === true && nav.success === false && typeof nav.navigationError === 'string';
        await appendFile(OUTPUT, `${JSON.stringify({ kind: 'request', scenario, phase: 'warm', iteration, category: 'chrome_navigate_error', elapsedMs: failure.elapsedMs, responseChars: failure.responseChars, responseBytes: failure.responseBytes, success: rejected })}\n`);
        assert.ok(rejected, 'failed navigation was incorrectly reported as success');
      }
      const wallClockMs = performance.now() - start;
      timings.push(wallClockMs);
      await appendFile(OUTPUT, `${JSON.stringify({ kind: 'workflow', scenario, phase: 'warm', iteration, wallClockMs, calls: scenario === 'B_scoped_dom' || scenario === 'D_missing_and_navigation_failure' ? 3 : 2, oracle: { validated: true } })}\n`);
    }
    scenarios.push({ name: scenario, samples: timings, calls: scenario === 'B_scoped_dom' || scenario === 'D_missing_and_navigation_failure' ? 3 : 2, oracle: 'validated' });
  }
  console.log(JSON.stringify({ output: OUTPUT, setupMs, firstWorkflowMs: initialMs, warmRepetitions: samples.length, scenarios: scenarios.map(s => {
    const sorted = [...s.samples].sort((a, b) => a - b);
    const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
    return { scenario: s.name, warmSamplesMs: s.samples, medianMs: sorted[Math.floor(sorted.length / 2)], p95DescriptiveMs: sorted[Math.ceil(0.95 * sorted.length) - 1], rangeMs: [sorted[0], sorted.at(-1)], varianceMs2: sorted.reduce((a, b) => a + (b - mean) ** 2, 0) / sorted.length, calls: s.calls, oracle: s.oracle };
  }), coldRepetitions: 0, note: 'cold requires fresh owned tabs; no browser restart or reload is performed' }, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(error => { console.error(`benchmark_failed:${error.message}`); process.exitCode = 1; });
}
