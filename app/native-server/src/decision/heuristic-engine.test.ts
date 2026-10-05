import { describe, expect, test } from '@jest/globals';
import { HeuristicEngine, tokenizeGoal } from './heuristic-engine';

describe('Heuristic Decision Engine Tests (§4.3)', () => {
  const engine = new HeuristicEngine();

  describe('1. Tokenization and CJK bigrams', () => {
    test('splits CJK characters into character bigrams', () => {
      const tokens = tokenizeGoal('搜索百度一下');
      expect(tokens).toContain('搜索');
      expect(tokens).toContain('索百');
      expect(tokens).toContain('百度');
    });

    test('strips punctuation and common stopwords', () => {
      const tokens = tokenizeGoal('click on the "Submit" button in the form!');
      expect(tokens).toContain('click');
      expect(tokens).toContain('submit');
      expect(tokens).toContain('button');
      expect(tokens).toContain('form');
      expect(tokens).not.toContain('the');
      expect(tokens).not.toContain('in');
      expect(tokens).not.toContain('on');
    });
  });

  describe('2. Element scoring and confidence calculation', () => {
    test('selects current WebClaw [index|ref] DOM lines as executable clicks', () => {
      const decision = engine.evaluate(
        'Click the Continue button',
        ['[1|e1] button "Continue" #continue'],
        [],
      );

      expect(decision.topCandidates[0]?.index).toBe(1);
      expect(decision.shouldEscalate).toBe(false);
      expect(decision.action).toBe('click');
      expect(decision.targetIndex).toBe(1);
    });

    test('does not choose a matching searchbox for an explicit click on another role', () => {
      const decision = engine.evaluate(
        'Click Continue button',
        ['[1|e1] textbox "Continue"', '[2|e2] button "Continue"', '[3|e3] span "Continue"'],
        [],
      );

      expect(decision.shouldEscalate).toBe(false);
      expect(decision.action).toBe('click');
      expect(decision.targetIndex).toBe(2);
    });

    test('escalates rather than clicking arbitrary text for a click intent', () => {
      const decision = engine.evaluate('Click Continue', ['[3|e3] span "Continue"'], []);

      expect(decision.shouldEscalate).toBe(true);
    });

    test('escalates combined actions instead of guessing one target', () => {
      const decision = engine.evaluate(
        'Click Continue and type my name',
        ['[1|e1] button "Continue"', '[2|e2] textbox "Name"'],
        [],
      );

      expect(decision.shouldEscalate).toBe(true);
      expect(decision.action).toBe('escalate');
    });

    test('applies substring match bonus +2.0 and role bonus', () => {
      const elements = [
        '[1] link "首页" href="/"',
        '[12] button "登录" #login-btn',
        '[15] textbox "搜索输入框" placeholder="请输入关键词"',
      ];

      const decision = engine.evaluate('点击登录', elements, []);
      expect(decision.shouldEscalate).toBe(false);
      expect(decision.action).toBe('click');
      expect(decision.targetIndex).toBe(12);
      expect(decision.confidence).toBeGreaterThan(0.3);
    });

    test('matches element label contained inside a longer natural language goal (bidirectional)', () => {
      const elements = [
        '[1] link "首页" href="/"',
        '[12] button "登录" #login-btn',
        '[15] textbox "搜索输入框"',
      ];

      // Goal contains element label "登录", whereas element string is not a substring of goal
      const decision = engine.evaluate('请帮我点击登录按钮完成进入', elements, []);
      expect(decision.shouldEscalate).toBe(false);
      expect(decision.action).toBe('click');
      expect(decision.targetIndex).toBe(12);
      expect(decision.confidence).toBeGreaterThan(0.35);
    });

    test('matches secondary quoted attributes (e.g. placeholder) across multiple quotes on element', () => {
      const elements = [
        '[1] link "首页" href="/"',
        '[2] textbox name="email" placeholder="邮箱"',
        '[12] button "提交"',
      ];

      const decision = engine.evaluate('请在输入框输入你的邮箱地址', elements, []);
      expect(decision.shouldEscalate).toBe(false);
      expect(decision.action).toBe('type');
      expect(decision.targetIndex).toBe(2);
      expect(decision.confidence).toBeGreaterThan(0.35);
    });

    test('escalates on ambiguous targets with confidence < 0.30 (§4.3)', () => {
      const elements = ['[10] button "确定选项 A"', '[11] button "确定选项 B"'];

      const decision = engine.evaluate('点击确定', elements, []);
      expect(decision.shouldEscalate).toBe(true);
      expect(decision.reason).toMatch(/Ambiguous target match/i);
      expect(decision.topCandidates.length).toBe(2);
    });

    test('escalates on destructive actions (§4.3)', () => {
      const elements = ['[5] button "立即支付 $99"', '[6] link "取消"'];

      const decision = engine.evaluate('支付订单', elements, []);
      expect(decision.shouldEscalate).toBe(true);
      expect(decision.reason).toMatch(/destructive/i);
      expect(decision.targetIndex).toBe(5);
    });

    test('uses click only when the goal explicitly asks to focus a textbox', () => {
      const decision = engine.evaluate(
        'Click to focus the search box',
        ['[1|e1] searchbox "Search"'],
        [],
      );

      expect(decision.shouldEscalate).toBe(false);
      expect(decision.action).toBe('click');
      expect(decision.targetIndex).toBe(1);
    });

    test('selects type action for input fields', () => {
      const elements = ['[2] textbox "用户名" placeholder="请输入用户名"', '[3] button "登录"'];

      const decision = engine.evaluate('输入用户名 "alice"', elements, []);
      expect(decision.shouldEscalate).toBe(false);
      expect(decision.action).toBe('type');
      expect(decision.targetIndex).toBe(2);
    });

    test('selects select action for dropdown combobox elements', () => {
      const elements = ['[1] link "Home"', '[8] combobox "选择国家" #country'];

      const decision = engine.evaluate('选择国家', elements, []);
      expect(decision.shouldEscalate).toBe(false);
      expect(decision.action).toBe('select');
      expect(decision.targetIndex).toBe(8);
    });

    test('selects scroll_down for scrolling goals', () => {
      const elements = ['[1] link "Header"'];
      const decision = engine.evaluate('向下滑动查看更多内容', elements, []);
      expect(decision.shouldEscalate).toBe(false);
      expect(decision.action).toBe('scroll_down');
    });
  });

  describe('3. Goal done approximation', () => {
    test('requires a navigation/mutation signal plus keyword coverage', () => {
      const elements = [
        '[1] text "欢迎使用 BrowserClaw 自动化系统"',
        '[2] text "操作成功，已保存数据"',
      ];
      // Static keyword coverage alone must NOT declare success (false positive).
      expect(engine.isGoalDone('操作成功', elements)).toBe(false);
      expect(engine.isGoalDone('操作成功', elements, true)).toBe(true);
      expect(engine.isGoalDone('完全不相关的目标未达成', elements)).toBe(false);
    });
  });

  describe('4. Stuck detection', () => {
    test('detects stuck loop after 3 consecutive actions with no change', () => {
      const stuckHistory = [
        { step: 1, action: 'click [12]', outcome: 'urlChanged:false, mutated:false' },
        { step: 2, action: 'click [12]', outcome: 'urlChanged:false, mutated:false' },
        { step: 3, action: 'click [12]', outcome: 'urlChanged:false, mutated:false' },
      ];
      expect(engine.isStuck(stuckHistory)).toBe(true);

      const movingHistory = [
        { step: 1, action: 'click [12]', outcome: 'urlChanged:false, mutated:true' },
        { step: 2, action: 'click [12]', outcome: 'urlChanged:false, mutated:false' },
        { step: 3, action: 'click [12]', outcome: 'urlChanged:false, mutated:false' },
      ];
      expect(engine.isStuck(movingHistory)).toBe(false);

      const visualDiffHistory = [
        {
          step: 1,
          action: 'click [12]',
          outcome: 'urlChanged:false, mutated:false, visualDiff:0.08',
        },
        {
          step: 2,
          action: 'click [12]',
          outcome: 'urlChanged:false, mutated:false, visualDiff:0.00',
        },
        {
          step: 3,
          action: 'click [12]',
          outcome: 'urlChanged:false, mutated:false, visualDiff:0.00',
        },
      ];
      expect(engine.isStuck(visualDiffHistory)).toBe(false);
    });
  });
});
