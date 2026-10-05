export const DESTRUCTIVE_KEYWORDS: readonly string[] = [
  'pay',
  '支付',
  '付款',
  '删除',
  'delete',
  'purchase',
  'buy',
  'submit',
  '提交',
  '发送',
  'post',
  '发布',
  'confirm',
  '确认',
];

export function extractTextPayload(goal: string, textHint?: string): string | null {
  if (!goal) return textHint?.trim() || null;

  // 1. Quoted segments
  const quoteMatch = goal.match(/["“'「‘]([^"”'」’]+)["”'」’]/);
  if (quoteMatch && quoteMatch[1].trim()) {
    return quoteMatch[1].trim();
  }

  // 2. textHint parameter
  if (textHint && textHint.trim()) {
    return textHint.trim();
  }

  // 3. Trailing phrase after keyword; stop at common terminators/prepositions
  // instead of the first space so multi-word payloads survive.
  const trailingMatch = goal.match(
    /(?:输入|搜索|键入|填写|填入|type|enter|search for)\s*[:：]?\s*([^,，。;；\n]+?)(?=\s+(?:into|in|on|to)\b|\s*(?:到|进|入|至|并|后|里|中|框|栏)|["“'「‘]|$)/i,
  );
  if (trailingMatch && trailingMatch[1].trim()) {
    return trailingMatch[1].trim();
  }

  return null;
}

const LATIN_DESTRUCTIVE_KEYWORDS = DESTRUCTIVE_KEYWORDS.filter((kw) =>
  /^[a-zA-Z0-9_-]+$/.test(kw.trim()),
);
const NON_LATIN_DESTRUCTIVE_KEYWORDS = DESTRUCTIVE_KEYWORDS.filter(
  (kw) => !/^[a-zA-Z0-9_-]+$/.test(kw.trim()),
);
const LATIN_DESTRUCTIVE_REGEX = new RegExp(
  `(^|[^a-zA-Z0-9])(${LATIN_DESTRUCTIVE_KEYWORDS.map((k) => k.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?=[^a-zA-Z0-9]|$)`,
  'i',
);

/**
 * Check if element text or label hits destructive keywords
 */
/**
 * Extract the human-visible label/text from a compact element line so keyword
 * matching only sees what the user actually reads — never the technical id /
 * class / href attributes. Prevents false positives like the Reddit
 * "Add tags" button whose id is "#reddit-post-flair-button" (kebab-case "post"
 * was matching the destructive keyword and blocking a benign tag action).
 *
 * Compact format: "[index] [flags] role \"text\" #id ..." → returns "text".
 * HTML format:    "<tag ...>\"text\"</tag>" or "<tag ...>text</tag>".
 * Fallback:       strip "#id" and selector attributes, keep the remainder.
 */
function extractTargetVisibleText(raw: string): string {
  if (!raw) return '';
  if (/^\[\d+\]/.test(raw)) {
    const quotedMatch = raw.match(/^\[\d+\](?:\s*\[[\w-]+\])*\s*[a-zA-Z-]+\s*"([^"]+)"/);
    if (quotedMatch) return quotedMatch[1];
    const htmlMatch = raw.match(/>\s*"?([^"<]+)"?\s*</);
    if (htmlMatch) return htmlMatch[1];
    return raw.replace(/#[\w-]+/g, '').replace(/\b(?:href|name|placeholder)="[^"]*"/g, '');
  }
  return raw;
}

export function isDestructiveTarget(text: string): boolean {
  if (!text) return false;
  const targetText = extractTargetVisibleText(text);
  if (LATIN_DESTRUCTIVE_REGEX.test(targetText)) return true;
  const lower = targetText.toLowerCase();
  for (const kw of NON_LATIN_DESTRUCTIVE_KEYWORDS) {
    if (lower.includes(kw.trim().toLowerCase())) return true;
  }
  return false;
}
