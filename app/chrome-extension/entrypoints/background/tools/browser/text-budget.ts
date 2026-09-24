/**
 * Hard output budgets for browser tool payloads.
 *
 * Tools that ship page-derived text (read_dom's pruned tree, get_markdown's
 * converted markdown) can return hundreds of kilobytes on heavy SPAs, which
 * burns the caller's context for a single turn. `budgetText` is the single
 * place that clamps such a string to a caller-visible character budget.
 *
 * Contract:
 * - `text` never exceeds `maxChars` once the truncation notice is folded into
 *   the budget (the slice is shortened by the notice length).
 * - `totalChars` is always the TRUE length of the original string, so a caller
 *   can tell how much was dropped.
 * - when the input fits, the original string is returned untouched
 *   (`truncated: false`, `totalChars === text.length`).
 */

/** Default per-response character budget shared by read_dom and get_markdown. */
export const DEFAULT_OUTPUT_BUDGET_CHARS = 120_000;

export interface TextBudgetResult {
  /** The (possibly truncated) text — always <= maxChars when truncated. */
  text: string;
  /** True when something was dropped. */
  truncated: boolean;
  /** Length of the ORIGINAL, untruncated text. */
  totalChars: number;
}

/**
 * Slice `source` to at most `keep` code units WITHOUT splitting a surrogate
 * pair: if the cut would land between a high and a low surrogate, back off one
 * unit so an astral character (emoji) is either kept whole or dropped whole.
 */
function safeCut(source: string, keep: number): string {
  if (keep <= 0) return '';
  let end = Math.min(keep, source.length);
  const last = source.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return source.slice(0, end);
}

/**
 * Clamp `text` to `maxChars` characters, reporting the true original length.
 *
 * Hard invariant: `text.length <= maxChars` for every `maxChars >= 0`, with no
 * exception for tiny budgets — when the truncation notice cannot fit inside the
 * cap we drop the notice rather than exceed it. Truncation is still signalled
 * by `truncated: true` and the TRUE `totalChars`, so the caller can always tell
 * that (and how much) content was dropped. The cut never splits a surrogate
 * pair.
 */
export function budgetText(
  text: string,
  maxChars: number = DEFAULT_OUTPUT_BUDGET_CHARS,
): TextBudgetResult {
  const source = typeof text === 'string' ? text : '';
  const totalChars = source.length;

  // Non-finite caps mean "no budget" — pass the source through untouched.
  if (!Number.isFinite(maxChars)) {
    return { text: source, truncated: false, totalChars };
  }

  const cap = Math.max(0, Math.floor(maxChars));
  if (totalChars <= cap) {
    return { text: source, truncated: false, totalChars };
  }

  const notice = `\n…[truncated: showing ${cap} of ${totalChars} chars]`;
  if (notice.length <= cap) {
    // Fold the notice into the budget so the returned text stays within maxChars.
    return { text: safeCut(source, cap - notice.length) + notice, truncated: true, totalChars };
  }

  // Budget too small for the notice: drop it rather than exceed the cap. The
  // caller still learns about the truncation from `truncated`/`totalChars`.
  return { text: safeCut(source, cap), truncated: true, totalChars };
}
