# Web-task speed benchmark (Phase 0.2)

This is a tool-only baseline against deterministic local fixture pages in visible Chrome. It records request durations using a monotonic clock, workflow wall time, response bytes/chars, call counts, and oracle coverage. It never writes tool arguments, page content, URLs, or the bridge token to the JSONL file. Output defaults to `$TMPDIR/webclaw-bench/` when Hermes sets `TMPDIR`.

## Oracle-first check

From the repo root:

```bash
node test/bench/web-task-speed.mjs --self-test
```

The self-test first accepts the complete known-good answer, then asserts that missing rows, missing-field reports, omitted `sourceRefs`, and a failed navigation cannot pass. It makes no browser calls.

## Live baseline

Open `test/bench/fixtures/index.html` in a **new agent-owned background tab** in the user's visible Chrome/WebClaw browser, and note its numeric tab ID. Do not reuse an existing personal tab. Run:

```bash
node test/bench/web-task-speed.mjs --tab-id <owned-tab-id> --warm 5 --out "$TMPDIR/webclaw-baseline.jsonl"
```

The runner initializes one MCP session, passes `browserId: "chrome"` and an explicit `tabId` on every tool call, and navigates the owned tab to both fixture pages. The two pages contain 20 deterministic records apiece (40 total), each with `id`, `name`, `region`, `score`, and `status`. Extraction pins **rows** with `selector: '#records tbody tr'` (scoping to the region instead pins a single item). Every returned cell is compared against the oracle; each page's 100 provenance refs must match `/^e\d+$/`, and `missing` must be empty. The script exits nonzero on any mismatch or tool-reported failure.

The runner also measures a full DOM read against `#form-region`, a delayed form with an `assert` retry versus a fixed 500 ms `wait`, a declared missing field, and a failed **file** navigation. The missing-file check is not an HTTP 404 test. All scenarios fail nonzero on a broken oracle. Five warm repetitions per path run on the same visible Chrome instance, but the arms are **not interleaved**. `--diagnose-batch` separately times fill, click, assert, and extract; it uses more calls and is not a comparable workflow benchmark. Cold browser samples and agent/model turn timing are **not** implemented. Do not extrapolate from this script to LLM latency. No extension reload or browser restart is performed.

### September 25, 2026 observation (not an A/B speedup)

One 5-repeat run returned a ~4,002 ms median for two-page extraction (navigation ~1,990 ms/call, extraction ~8 ms/call); a later 5-repeat run on the same browser returned ~132 ms (navigation ~58 ms/call). The extension/other agents' dirty changes were active during these runs; no controlled candidate was installed by this benchmark. **Do not quote a speedup factor or attribute the difference to this harness.** The delayed-form runs also fluctuated strongly. Current evidence supports continuing instrumentation and ownership coordination, not shipping a speculative optional API.
