# webclaw token & speed playbook

Everything here is measured, not estimated. Two evidence sources:

**webclaw today** (live extension + bridge, 2026-09-25):

| Measurement                                                       | Value                                                                                  |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 18 core tool schemas as installed for Hermes                      | **45,349 chars ≈ 11.3k tokens**                                                        |
| `tool_describe` of 6–7 tools (what an agent loads before working) | **~18,000 chars**                                                                      |
| Biggest schema offenders                                          | `batch_actions` 8,144 · `interact_index` 6,873 · `screenshot` 5,791 · `read_dom` 4,246 |
| `read_dom(limit=25)` response                                     | 2,385 chars, **675 (28%) boilerplate**                                                 |
| `pipelineHint` — repeated on _every_ `read_dom`                   | 268 chars (11.6% of that payload)                                                      |
| `grep` fallback response                                          | 848 chars, **331 (39%) static prose** (`scanScope` 150 + `note` 181)                   |
| `read_dom` assets block, emitted unasked                          | 180 chars + one line per asset                                                         |
| `get_markdown` on one ordinary page, one call                     | **83,955 chars** (default cap 120,000)                                                 |
| One screenshot, inline base64 (observed)                          | **~59,600 chars**                                                                      |
| Failed `scroll_until_found`                                       | 25 steps / 20,000 px scrolled before giving up                                         |

**QA Tester AI's diet** (same repo family, `D:\QA Tester AI`, branch `token-diet`,
`TOKEN_EFFICIENCY_REPORT.txt`) — a real A/B on a physical phone, run twice:

|                   | before | after                      |
| ----------------- | ------ | -------------------------- |
| turns             | 50     | 21–22 (−57%)               |
| wall clock        | 3m 10s | 1m 02–06s (**~3× faster**) |
| cache-read tokens | 2.96M  | 365–412k (**−86 to −88%**) |
| tokens written    | 125k   | 45–48k (−62%)              |
| accuracy          | 3/3    | 3/3 (unchanged)            |

Their biggest single win was **cutting the fixed per-request cost** — ~35 tool
descriptions sent every turn, long paragraphs, tools never used. webclaw has the same
shape of problem (45k chars of schema; 18k chars just to load a handful) and the same
fix, plus cheaper payloads and fewer turns.

---

## The five rules

1. **A response may claim success only with the artifact that proves it** (elements,
   status, or a machine-readable reason: `unchanged` / `noop` / `missing` / `stale_ref`).
   Prose is not evidence. Silent failure costs more than any token saving.
2. **Teach once, not every turn.** Anything static that rides in every response belongs
   in `tool_docs` (or the first call of a session).
3. **Cap by default, with an honest marker.** Every list, tree and text block has a
   default ceiling and an "… N more" / truncation notice carrying the true total.
4. **Never send the same bytes twice** — no unchanged trees, no assets nobody asked
   about, no base64 in two fields.
5. **Turns are the cost, not milliseconds.** Every call was sub-second to ~4s; the money
   is in how many calls a task takes and how big the context grows behind them.

---

## Techniques

Each item: what to do, where, expected effect, how to verify. Order = impact ÷ effort.

### E1 — Shorten the tool schemas (biggest fixed win)

- **Do:** every tool description → 1–2 sentences; move the elaboration into `tool_docs`
  (the on-demand tier already exists — that is the "load rarely-used tools only when
  needed" half of the trick). Delete deprecated aliases: `screenshot`'s `highlight`,
  `setOfMark`, `enableGrid`, `crop`, `saveToDisk`, and `*_index`'s `index`-alias params.
  Collapse per-parameter essays to one clause each.
- **Where:** `packages/shared/src/tools.ts` (schemas) → rebuild `chrome-mcp-shared` →
  `plugins/browserclaw/core_schemas.json` + `plugin.yaml` + `__init__.py` → installed copy
  under `%LOCALAPPDATA%/hermes/plugins/browserclaw/`. All three sites or the param is
  silently stripped.
- **Effect:** 45,349 chars → target **<20,000**, and the 18k `tool_describe` moment →
  target **<6,000**. This is paid on _every_ agent that touches the tool.
- **Verify:** `python -c "import json;d=json.load(open('core_schemas.json'));print(sum(len(json.dumps(v)) for v in d.values()))"`
  plus `tests/tool-surface-parity.test.ts` and `tests/tool-schema-contract.test.ts` green.

### E2 — Kill repeated in-band prose (teach once)

- **Do:** `pipelineHint` (268 chars) → first `read_dom` of a session only, or behind
  `verbose:true`; document it in `tool_docs`. `grep`'s `scanScope` + `note` (331 chars) →
  machine fields (`searchType`, `fallbackUsed:true`, `scanScope:"page_text"`), documented
  once in `tool_docs`.
- **Where:** `entrypoints/background/tools/browser/read-dom.ts:695` (the hint string),
  `grep.ts:389-390` (scanScope), and the `note` next to it.
- **Effect:** `read_dom` −11%, `grep` fallback **−39%**.
- **Verify:** re-run the same calls; assert `chars` drop and the fields still parse.

### E3 — Default caps with honest markers

- **Do:** give `read_dom` a default element `limit` (start at 40, like QA's 40 texts /
  30 elements) with the existing "… N more" marker; `get_markdown` defaults to
  `fit:true` when no `selector` is passed and a `maxLength` of ~40,000 (the honest
  truncation notice already exists), plus a cheap `mode:"outline"` (headings + table
  shapes) so an agent can look before it pulls.
- **Where:** `read-dom.ts` (default limit), `get-markdown.ts:111` (the
  `args.maxLength ?? DEFAULT_OUTPUT_BUDGET_CHARS` line — change the default, keep the
  escape hatch), `text-budget.ts`.
- **Effect:** one `get_markdown` call 83,955 → under 20k typical, ≤40k worst case; big
  pages stop arriving at 120k.
- **Risk:** changes existing behaviour — keep `maxLength`/`limit` overrides and say so in
  the description.
- **Verify:** same page, before/after char counts; assert the truncation notice reports
  the true original length.

### E4 — Asset & screenshot economics

- **Do:** emit the `[Visual Assets]` block and asset lines only when asked
  (`includeAssets:true`) or when the caller requested media; cap viewport captures at
  `maxWidth:800` (keep `maxWidth`/`region`/`highClarity` for when detail matters); bias
  the docs and the hint toward `assetIndex` / `region` / `targetIndex` crops instead of
  full-page shots; never emit base64 in text _and_ image content.
- **Where:** `read-dom.ts` assets emission; `screenshot.ts` defaults
  (`format:'webp'`, `quality:80`, `maxWidth:1280` → 800 for non-crop captures).
- **Effect:** −180 chars on every `read_dom`; one screenshot ~59,600 → ~15–20k for a
  cropped/800px capture.
- **Verify:** capture the same element before/after; compare chars.

### E5 — Make the diff read actually work (correctness × tokens)

- **Do:** key the `read_dom` "unchanged" short-circuit on **the request** as well as the
  DOM — `cursor`, `limit`, `format`, `maxTextLength`, `activeViewportOnly`. A repeat of
  the identical request may still return the 227-char compact payload.
- **Where:** `read-dom.ts:536-575` (the `diff.isDelta && diff.unchanged` early return,
  before the pagination block).
- **Effect:** keeps the −90% repeat-read saving _and_ stops the silent empty page-2.
- **Verify:** new test `tests/read-dom-delta-pagination.test.ts` (prime snapshot → read
  with `cursor:10` → assert tree + elements present).

### E6 — Batch-first interaction (fewer turns)

- **Do:** make `batch_actions` (or `fill_index{pressEnter:true}`) the default advice, with
  in-batch `waitFor` conditions (text / URL / element) so fill → click → verify is one
  call. Trim its 8,144-char schema as part of E1 — sending the pitch on every `read_dom`
  is what E2 removes.
- **Where:** `batch_actions` implementation + the (now first-call-only) hint.
- **Effect:** fewer turns per task; QA's `tap_sequence`/`fill_form` is the same trick and
  part of their 50→21 turns.
- **Verify:** benchmark scenario "form fill + submit" must complete in **1 call**.

### E7 — Limits and early exits (time, and fewer retries)

- **Do:** `scroll_until_found` stops when the page bottom is reached (a failed 25-step
  20,000 px scroll is latency for nothing) and returns `found:false` + `reason` +
  `closestMatches`; `navigate` resolves on `readyState:complete` / network-idle with a
  bounded timeout so the next read doesn't need a retry; `dismissOverlays` auto-fires once
  per tab and reports `dismissed:[…]`.
- **Where:** the scroll tool, `navigate.ts`, overlay handling.
- **Effect:** kills the retry-after-navigate pattern and wasted scroll steps.
- **Verify:** scroll for text that isn't on the page → expect a fast honest failure;
  navigate then read → expect no retry (a subagent hit one transient retry today).

### E8 — `_meta` + stable bytes for prompt caching

- **Do:** add `{chars, truncated, totalChars, elapsedMs}` to every response (additive
  only — never rename or repurpose existing fields), so cost is visible to both the agent
  and the benchmark. Keep schema bytes stable so provider-side prompt caching keeps
  hitting: no timestamps, no interpolated tool names inside schemas.
- **Where:** `result-envelope.ts`.
- **Effect:** free measurement from then on; QA's cache-hit tip is the same idea (their
  prompt is kept byte-identical).
- **Verify:** `tests/result-envelope.test.ts` still green; two identical calls produce
  identical bytes apart from `_meta`.

### E9 — Keep the loading tier honest

- **Do:** the 18-tool core stays deferred (already true); tier-gated categories
  (`perceive`, `power`) must never be activated speculatively — a 6–7 tool `tool_describe`
  costing 18k chars is the cautionary example.
- **Where:** `tool-profiles.ts`, `plugins/browserclaw/*`.
- **Verify:** an agent that needs "read the page" should load ≤2 tool schemas.

### E10 — Agent-side habits (put these in the tool's own docs/hints)

- Reuse `ref` instead of re-reading (ref is stable identity; `index` is positional).
- Don't re-read a page you just read — ask for the delta.
- One pipeline per turn; don't split fill and submit.
- Reset your own context at task boundaries; the tool keeps responses small so the
  context stays small (QA's per-case reset, adapted — a browser tool cannot reset the
  agent for it).

---

## Measure it (5 minutes, before and after)

1. Start one scratch tab: `browserclaw_navigate {url, windowId, background:true}`.
2. Time each call and capture the raw text; chars ÷ 4 ≈ tokens.
3. Per tool, record: **calls, chars, seconds, success**.
4. The scoring scenarios (each with a machine-checkable truth):

| #   | Scenario                                        | Ground truth                          |
| --- | ----------------------------------------------- | ------------------------------------- |
| 1   | httpbin form: fill 3 fields + radio + submit    | echoed JSON equals what was sent      |
| 2   | search → click a result                         | final URL                             |
| 3   | structured extract of one table row             | the cell values                       |
| 4   | paginate a long list (`limit`+`cursor` twice)   | page 2 is non-empty and different     |
| 5   | deep scroll to a real target / to a missing one | found / honest failure, steps used    |
| 6   | navigate to 404 / unresolvable host             | failure signalled, not `success:true` |

5. Log one JSONL line per scenario run (like QA's `runs.jsonl`), so improvements are
   comparable across commits. Re-run twice per change — QA's two runs agreed, and that is
   what made their number credible.

Helper already on disk: `C:\Users\MRsiy\AppData\Local\hermes\skills\webclaw\scripts\bridge_mcp.py`
(direct bridge calls, tier-3 `chrome_javascript`/`chrome_cdp_execute` activation) — useful
because the Hermes plugin does not expose those two.

---

## Targets

| Metric                                 | Today   | Target                       |
| -------------------------------------- | ------- | ---------------------------- |
| total tool schema bytes                | 45,349  | < 20,000                     |
| chars to load a working toolset        | ~18,000 | < 6,000                      |
| typical `read_dom` payload (limit 25)  | 2,385   | < 1,800                      |
| `grep` fallback payload                | 848     | < 500                        |
| one `get_markdown` call                | 83,955  | < 20,000 typical, 40,000 cap |
| one screenshot                         | ~59,600 | < 20,000 (crop/800px)        |
| chars per completed benchmark scenario | measure | **−50 to −70%**              |
| calls per scenario                     | measure | −20 to −30%                  |
| success claims without proof           | 3 known | **0** (rule 1)               |

---

## Do not do (learned the expensive way)

- **Don't raise the context cap and compact the oldest part.** QA tried this first and
  rejected it: the provider window is 200k and the cost is the _live_ size re-sent every
  turn, not the total. Keep every response small instead.
- **Don't compact on a percentage threshold mid-task.** Cut at task boundaries, where it
  is lossless — mid-task compaction looks exactly like the agent forgetting what it was
  doing.
- **Don't return a payload that answers a different question than the one asked** (the
  `read_dom` dedup bug), and don't return `success:true` with nothing in it (the
  `navigate` 404 bug). Both cost more turns than they ever save.
- **Don't put dynamic text in schemas** (timestamps, interpolated tool names) — it breaks
  prompt caching for everyone downstream.
- **Don't rename or repurpose existing response fields while trimming.** Additive only;
  that invariant is in `AGENTS.md §6` for a reason.
- **Don't trust a per-worker "all green" report after parallel edits** — QA lost 13 tests
  to shared things (a tool name, an exact sentence a test asserted, a global setting).
  webclaw's shared points: the three declaration sites, `ref`/`index`, the verdict
  vocabulary. Run the full suite (80 files / 669 tests) after merging.
- **Don't test an unreloaded bundle.** `.output/chrome-mv3` being newer proves nothing;
  rebuild → `/reload-extension` → check a marker only the new bundle emits.

---

## Suggested order

1. **E5** (correctness, small diff, unblocks the diff-read saving)
2. **E2** (cheap deletions, immediately measurable)
3. **E1** (biggest fixed win, touches the three declaration sites — do it in one sitting)
4. **E3 + E4** (defaults and payload caps)
5. **E7 + E6** (fewer turns and retries)
6. **E8** (free measurement for everything after)
7. Re-run the harness, then write the numbers into the README's _Measured, not claimed_
   section.
