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
 * Clamp `text` to `maxChars` characters, reporting the true original length.
 * Truncation happens on a character boundary: the cut is a plain code-unit
 * slice, which is what every upstream consumer already assumes.
 */
export function budgetText(
  text: string,
  maxChars: number = DEFAULT_OUTPUT_BUDGET_CHARS,
): TextBudgetResult {
  const source = typeof text === 'string' ? text : '';
  const totalChars = source.length;

  if (!Number.isFinite(maxChars) || maxChars <= 0 || totalChars <= maxChars) {
    return { text: source, truncated: false, totalChars };
  }

  const notice = `\n…[truncated: showing ${maxChars} of ${totalChars} chars]`;
  // Fold the notice into the budget so the returned text stays within maxChars.
  const keep = Math.max(0, maxChars - notice.length);
  const text2 = source.slice(0, keep) + notice;

  return { text: text2, truncated: true, totalChars };
}
