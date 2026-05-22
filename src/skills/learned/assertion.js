// assertion — prompt 输出验证 helper（W11 promptfoo 学习）
// 独立 helper，未接入 adapter——等 sprint 级独立集成

/**
 * 单个 assertion 定义：
 *   { type: 'contains', value: 'X' }                  → 必含 X
 *   { type: 'not_contains', value: 'Y' }              → 必不含 Y
 *   { type: 'min_length', value: 100 }                → 长度 >= 100
 *   { type: 'max_length', value: 5000 }               → 长度 <= 5000
 *   { type: 'json_valid' }                            → 合法 JSON
 *   { type: 'regex', value: '^[A-Z]' }                → 正则匹配
 *   { type: 'json_path', path: 'data.x', expect: 1 }  → JSON 字段 == expect
 */

export function runAssertion(output, assertion) {
  if (!assertion || !assertion.type) return { pass: true, reason: 'no assertion' };
  const text = String(output || '');

  switch (assertion.type) {
    case 'contains':
      return { pass: text.includes(assertion.value), reason: text.includes(assertion.value) ? 'ok' : `缺 "${assertion.value}"` };

    case 'not_contains':
      return { pass: !text.includes(assertion.value), reason: !text.includes(assertion.value) ? 'ok' : `含禁词 "${assertion.value}"` };

    case 'min_length':
      return { pass: text.length >= assertion.value, reason: `len=${text.length} ${text.length >= assertion.value ? '>=' : '<'} ${assertion.value}` };

    case 'max_length':
      return { pass: text.length <= assertion.value, reason: `len=${text.length} ${text.length <= assertion.value ? '<=' : '>'} ${assertion.value}` };

    case 'json_valid':
      try { JSON.parse(text); return { pass: true, reason: 'json ok' }; }
      catch (e) { return { pass: false, reason: 'json parse: ' + e.message }; }

    case 'regex': {
      try {
        const re = new RegExp(assertion.value, assertion.flags || '');
        const m = re.test(text);
        return { pass: m, reason: m ? 'regex match' : 'regex no match' };
      } catch { return { pass: false, reason: 'invalid regex' }; }
    }

    case 'json_path': {
      try {
        const obj = JSON.parse(text);
        const val = assertion.path.split('.').reduce((o, k) => o?.[k], obj);
        const pass = val === assertion.expect;
        return { pass, reason: pass ? 'json path match' : `path ${assertion.path} = ${JSON.stringify(val)} != ${JSON.stringify(assertion.expect)}` };
      } catch (e) { return { pass: false, reason: 'json path err: ' + e.message }; }
    }

    default:
      return { pass: false, reason: 'unknown assertion type: ' + assertion.type };
  }
}

/**
 * 跑一组 assertion
 */
export function runAssertions(output, assertions = []) {
  const results = assertions.map(a => ({ ...a, ...runAssertion(output, a) }));
  return {
    allPass: results.every(r => r.pass),
    failed: results.filter(r => !r.pass),
    results,
  };
}

/**
 * 用法（未来接入）：
 *   const assertions = [
 *     { type: 'min_length', value: 200 },
 *     { type: 'not_contains', value: 'AI 道德要求' },  // 防 refusal
 *     { type: 'contains', value: '方案' },
 *   ];
 *   const { allPass, failed } = runAssertions(turn.content, assertions);
 *   if (!allPass) {
 *     // 标记 turn error 或要求重试
 *   }
 */
