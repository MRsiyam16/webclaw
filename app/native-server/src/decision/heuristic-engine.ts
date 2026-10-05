/**
 * Heuristic Decision Engine conforming to §4.3
 * Deterministic fallback scoring (~120 lines, zero dependencies).
 */

import { BrowserActionType, ActionHistoryItem } from './types';
import { isDestructiveTarget } from './decision-utils';

const STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'in',
  'on',
  'at',
  'to',
  'for',
  'of',
  'with',
  'by',
  'is',
  'are',
  'was',
  'were',
  'and',
  'or',
  'not',
  'it',
  'this',
  'that',
  'from',
  'as',
  'be',
  'into',
  'then',
  '的',
  '了',
  '在',
  '是',
  '我',
  '有',
  '和',
  '就',
  '不',
  '人',
  '都',
  '一',
  '一个',
  '上',
  '也',
  '很',
  '到',
  '说',
  '要',
  '去',
  '你',
  '会',
  '着',
  '没有',
  '看',
  '好',
  '自己',
  '这',
  '那',
  '点',
  '下',
]);

/**
 * Tokenize string into alphanumeric words and CJK character bigrams
 */
export function tokenizeGoal(text: string): string[] {
  const normalized = text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ');
  const rawWords = normalized.split(/\s+/).filter(Boolean);
  const tokens: string[] = [];

  for (const word of rawWords) {
    if (STOPWORDS.has(word)) continue;
    // Split mixed scripts BEFORE bigramming: the old code dropped embedded
    // Latin/digit runs ("搜索iPhone15购买" lost "iphone15") and forged
    // cross-word bigrams ("索购").
    const segments = word.match(
      /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+|[\p{L}\p{N}_-]+/gu,
    );
    if (!segments) continue;
    for (const seg of segments) {
      const cjkChars = seg.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu);
      if (cjkChars && cjkChars.length >= 2 && cjkChars.length === seg.length) {
        for (let i = 0; i < cjkChars.length - 1; i++) {
          tokens.push(cjkChars[i] + cjkChars[i + 1]);
        }
      } else {
        tokens.push(seg.toLowerCase());
      }
    }
  }

  return tokens.length > 0 ? tokens : rawWords;
}

export interface HeuristicCandidate {
  index: number;
  line: string;
  role: string;
  score: number;
}

export interface HeuristicDecision {
  action: BrowserActionType;
  targetIndex?: number;
  targetLine?: string;
  confidence: number;
  topCandidates: HeuristicCandidate[];
  shouldEscalate: boolean;
  reason?: string;
}

export class HeuristicEngine {
  /**
   * Score elements and make a decision conforming to §4.3
   */
  public evaluate(
    goal: string,
    elements: string[],
    history: ActionHistoryItem[],
    confidenceThreshold = 0.3,
  ): HeuristicDecision {
    const goalTokens = tokenizeGoal(goal);
    const goalLower = goal.toLowerCase();
    // Hoist per-goal preprocessing out of the per-element loop.
    const cleanGoal = goalLower.replace(/[^\p{L}\p{N}]/gu, '');

    // Determine intent hints
    const wantsType = /(?:输入|填|type|input|search(?!\s*box)|搜索|write)/i.test(goalLower);
    const wantsClick = /(?:点击|点|click|button|按钮|press|打开|open|focus)/i.test(goalLower);
    const wantsScroll = /(?:滚动|scroll|翻页|往下|向下)/i.test(goalLower);
    const wantsSelect = /(?:选择|选|select|choose|pick|下拉)/i.test(goalLower);
    const wantsExplicitInputFocus =
      /(?:focus|focus on|聚焦|定位到).*(?:input|textbox|search box|搜索框)|(?:input|textbox|search box|搜索框).*(?:focus|focus on|聚焦)/i.test(
        goalLower,
      );

    if (wantsClick && (wantsType || wantsSelect)) {
      return {
        action: 'escalate',
        confidence: 0,
        topCandidates: [],
        shouldEscalate: true,
        reason: 'Combined click/type/select goal is unsupported by the bounded native action loop',
      };
    }

    const candidates: HeuristicCandidate[] = [];

    for (const line of elements) {
      const idxMatch = line.match(/^\[(\d+)(?:\|([^\]]+))?\]/);
      if (!idxMatch) continue;
      const index = parseInt(idxMatch[1], 10);
      const lineLower = line.toLowerCase();

      // Parse the actual role after the positional index and any [index|ref] token.
      const roleMatch = line.match(/^\[\d+(?:\|[^\]]+)?\](?:\s*\[[^\]]+\])*\s*([a-z]+)/i);
      const role = roleMatch ? roleMatch[1].toLowerCase() : '';
      const actionableClickRoles = new Set([
        'button',
        'link',
        'checkbox',
        'radio',
        'tab',
        'menuitem',
        'switch',
        'option',
      ]);
      const inferredClick = !wantsType && !wantsSelect && !wantsScroll;
      const eligible =
        wantsClick || inferredClick
          ? actionableClickRoles.has(role) ||
            (wantsExplicitInputFocus && ['textbox', 'searchbox'].includes(role))
          : wantsType
            ? ['textbox', 'searchbox'].includes(role)
            : wantsSelect
              ? ['combobox', 'select'].includes(role)
              : false;
      if (!eligible) continue;

      let score = 0;

      // 1. Substring match bonus: +2.0 (cleanGoal hoisted above the loop)
      const cleanLine = lineLower.replace(/[^\p{L}\p{N}]/gu, '');
      const quotedStrings = Array.from(line.matchAll(/"([^"]+)"/g)).map((m) =>
        m[1].toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''),
      );
      const htmlTextMatch = line.match(/>([^<]+)</);
      if (htmlTextMatch) {
        quotedStrings.push(htmlTextMatch[1].toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''));
      }

      const hasSubstringMatch =
        cleanGoal.length > 1 &&
        (cleanLine.includes(cleanGoal) ||
          quotedStrings.some(
            (label) => label.length > 1 && (cleanGoal.includes(label) || label.includes(cleanGoal)),
          ));

      if (hasSubstringMatch) {
        score += 2.0;
      }

      // 2. Token overlap ratio
      const lineTokens = new Set(tokenizeGoal(lineLower));
      let overlapCount = 0;
      for (const t of goalTokens) {
        if (lineTokens.has(t) || lineLower.includes(t)) {
          overlapCount++;
        }
      }
      if (goalTokens.length > 0) {
        score += (overlapCount / goalTokens.length) * 1.5;
      }

      // 3. Role bonus (§4.3)
      if (wantsClick && (role === 'button' || role === 'link' || role === 'checkbox')) {
        score += 0.5;
      }
      if (wantsType && (role === 'textbox' || role === 'searchbox')) {
        score += 0.5;
      }
      if (wantsSelect && (role === 'combobox' || role === 'select')) {
        score += 0.5;
      }
      if (role === 'link' && /(?:link|链接|open|打开)/i.test(goalLower)) {
        score += 0.5;
      }

      if (score > 0) {
        candidates.push({ index, line, role, score });
      }
    }

    candidates.sort((a, b) => b.score - a.score);

    if (candidates.length === 0) {
      if (wantsScroll) {
        return {
          action: 'scroll_down',
          confidence: 0.8,
          topCandidates: [],
          shouldEscalate: false,
        };
      }
      return {
        action: 'escalate',
        confidence: 0,
        topCandidates: [],
        shouldEscalate: true,
        reason: 'No matching interactive elements found on page for goal',
      };
    }

    const top1 = candidates[0];
    const top2 = candidates[1];
    const confidence = top1.score > 0 ? (top1.score - (top2?.score || 0)) / top1.score : 0;
    const topCandidates = candidates.slice(0, 3);

    // Destructive check (§4.3)
    if (isDestructiveTarget(top1.line)) {
      return {
        action: 'escalate',
        targetIndex: top1.index,
        targetLine: top1.line,
        confidence,
        topCandidates,
        shouldEscalate: true,
        reason: `Target element "${top1.line}" matched destructive keyword; requires confirmation`,
      };
    }

    // Confidence threshold -> escalate (§4.3); threshold comes from the caller
    // so the external confidenceThreshold parameter is honored on this path too.
    if (confidence < confidenceThreshold) {
      const candidateSummary = topCandidates.map((c) => `[${c.index}] ${c.line}`).join(' vs ');
      return {
        action: 'escalate',
        targetIndex: top1.index,
        targetLine: top1.line,
        confidence,
        topCandidates,
        shouldEscalate: true,
        reason: `Ambiguous target match (confidence ${confidence.toFixed(2)} < ${confidenceThreshold.toFixed(2)}): ${candidateSummary}`,
      };
    }

    // Action determination
    let action: BrowserActionType = 'click';
    if (wantsExplicitInputFocus) {
      action = 'click';
    } else if (
      top1.role === 'combobox' ||
      top1.role === 'select' ||
      (wantsSelect && !wantsType && !wantsClick)
    ) {
      action = 'select';
    } else if (
      top1.role === 'textbox' ||
      top1.role === 'searchbox' ||
      (wantsType && /(?:textbox|searchbox|input|textarea)/i.test(top1.line))
    ) {
      action = 'type';
    } else if (wantsScroll) {
      action = 'scroll_down';
    }

    return {
      action,
      targetIndex: top1.index,
      targetLine: top1.line,
      confidence,
      topCandidates,
      shouldEscalate: false,
    };
  }

  /**
   * Approximate goal completion by measuring keyword coverage across page text (>= 0.8)
   */
  public isGoalDone(
    goal: string,
    elements: string[],
    urlChangedInLastStep = false,
    mutatedInLastStep = false,
  ): boolean {
    const goalTokens = tokenizeGoal(goal);
    if (goalTokens.length === 0) return false;
    // Static keyword coverage alone false-positives on pages that already
    // contain the goal words ("点击用户登录" on a login page). Require at
    // least one navigation or DOM mutation signal before declaring victory.
    if (!urlChangedInLastStep && !mutatedInLastStep) return false;

    const allPageText = elements.join(' ').toLowerCase();
    let hitCount = 0;
    for (const token of goalTokens) {
      if (allPageText.includes(token)) {
        hitCount++;
      }
    }
    return hitCount / goalTokens.length >= 0.8;
  }

  /**
   * Check if stuck: same action on same target 3 consecutive times with no changes
   * Checks urlChanged, mutated, and visualDiff from perceptiveDelta (§4.3, §5.1)
   */
  public isStuck(history: ActionHistoryItem[]): boolean {
    if (history.length < 3) return false;
    const last3 = history.slice(-3);
    const firstAction = last3[0].action;

    const sameAction = last3.every((h) => h.action === firstAction);
    if (!sameAction) return false;

    const noChange = last3.every((h) => {
      const out = h.outcome.toLowerCase();
      const urlChanged = out.includes('urlchanged:true');
      const mutated = out.includes('mutated:true');
      const visualDiffMatch = out.match(/visualdiff:\s*([\d.]+)/);
      const visualChanged = visualDiffMatch ? parseFloat(visualDiffMatch[1]) > 0.01 : false;
      return !urlChanged && !mutated && !visualChanged;
    });

    return noChange;
  }
}
