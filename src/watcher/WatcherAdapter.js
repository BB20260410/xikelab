// WatcherAdapter — 监视者抽象基类
// 子类（MiniMaxAdapter / GeminiAdapter / OllamaAdapter / OpenAIAdapter）实现 judge()
// 任务：读 Claude session 的 messages + 主目标 + cwd，输出结构化 JSON 判断

/**
 * @typedef {Object} SessionState
 * @property {string} id
 * @property {string} name
 * @property {string} cwd
 * @property {string|null} mainGoal
 * @property {Array<{role:string,content:string,ts:string}>} messages 最近 N 条
 * @property {string} runState idle|thinking|running|completed|error
 */

/**
 * @typedef {Object} WatcherVerdict
 * @property {'completed'|'partial'|'stuck'|'need_user'|'failed'|'drifted'} status
 * @property {number} confidence 0.0 - 1.0
 * @property {string[]} completed_items
 * @property {string[]} remaining_items
 * @property {Object} next_action
 * @property {'continue'|'retry_with_hint'|'review'|'stop'|'escalate_to_user'} next_action.type
 * @property {string} next_action.prompt
 * @property {'safe'|'needs_review'} next_action.danger_level
 * @property {boolean} drift_detected
 * @property {string} reasoning
 */

export class WatcherAdapter {
  constructor({ apiKey, model, baseUrl, timeout = 30000 } = {}) {
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = baseUrl;
    this.timeout = timeout;
  }

  get name() { return 'abstract'; }

  /**
   * 子类实现：调监督模型 API，返回 WatcherVerdict
   * @param {SessionState} sessionState
   * @returns {Promise<WatcherVerdict>}
   */
  async judge(_sessionState) {
    throw new Error('WatcherAdapter.judge() must be implemented by subclass');
  }

  /** 通用 judge prompt 生成（子类可覆盖） */
  buildJudgePrompt(sessionState) {
    const msgs = (sessionState.messages || []).slice(-30).map(m => {
      const head = m.role === 'user' ? '👤 用户' :
                   m.role === 'assistant' ? '🤖 Claude' :
                   m.role === 'tool_use' ? '🔧 工具' :
                   m.role === 'system' ? '⚙️ 系统' : m.role;
      const body = (m.content || '').slice(0, 800);
      return `${head}: ${body}`;
    }).join('\n\n');

    return `# 你的角色：Claude session 监督者

## 🎯 OBJECTIVE
读完最近 30 条对话，判断 Claude 任务进展，输出结构化 verdict + 下一步建议。

## 📥 INPUT
### 项目上下文
- session 名: ${sessionState.name || '未命名'}
- cwd: ${sessionState.cwd || '未知'}
- 主目标: ${sessionState.mainGoal || '（用户未设主目标）'}
- 当前状态: ${sessionState.runState || 'idle'}

### 最近对话（最多 30 条，每条截 800 字）
${msgs}

## 📤 OUTPUT FORMAT
严格 JSON（不要 markdown 围栏，前后无任何文字）。字段定义如下，**不要把字段定义/示例文本当作值**：

- **status** — 6 选 1 字符串（**只填一个值**）：
  * completed = 主目标完成 + 无未决工具调用 + Claude 自己说"完成了"
  * partial = 还有明显未做的事
  * stuck = Claude 在重复尝试同一件事失败
  * need_user = Claude 主动停下问问题等用户介入
  * failed = 报错且无法自动恢复
  * drifted = Claude 偏离主目标做无关的事

- **confidence** — 0.0-1.0 数字（**不要恒填 0.95**），按以下评分：
  * 0.9-1.0：100% 完整完成，无任何残留
  * 0.7-0.89：完成主线但小细节有瑕疵
  * 0.5-0.69：完成 50-80%
  * 0.3-0.49：完成不足一半
  * <0.3：基本失败或卡死

- **completed_items** — 数组，每项 1 个具体动作（["写了 LoginForm", "加了 onSubmit 校验"]）
- **remaining_items** — 数组，未做的事
- **next_action.type** — 5 选 1：continue / retry_with_hint / review / stop / escalate_to_user
- **next_action.prompt** — 给 Claude 的**具体指令**（"补全 LoginForm 输入验证"，不要"请继续"）
- **next_action.danger_level** — safe 或 needs_review（含 rm / git push --force 等危险命令时 needs_review）
- **drift_detected** — bool
- **reasoning** — 必须中文，2-3 句判断理由

### 输出范例（仅参考格式，不要直接抄）
{"status":"completed","confidence":0.92,"completed_items":["写了 hello.py","打印 Hello World"],"remaining_items":[],"next_action":{"type":"stop","prompt":"","danger_level":"safe"},"drift_detected":false,"reasoning":"任务简单，Claude 一次就完成了，无遗漏。"}

## 🛠 TOOLS GUIDANCE
- 你只看对话，不能跑代码/查文件
- 判断 status 优先看 Claude 最近的发言是否说"完成"，再核对工具调用是否还有 pending
- confidence 一致性自检：completed 且 remaining 非空 → confidence ≤ 0.5
- next_action.prompt 是要"原文发给 Claude"的，写完整指令而非简述

## ⛔ BOUNDARY
- 只输出 JSON 对象，前后零文字
- 不要输出 markdown 代码围栏（\`\`\`json）
- reasoning 不能英文`;
  }

  /** 通用 JSON 解析 + schema 校验 */
  validateVerdict(raw) {
    let obj;
    try {
      // 容错：剥 markdown code fence
      const cleaned = raw.replace(/^```(json)?\s*/i, '').replace(/```\s*$/i, '').trim();
      obj = JSON.parse(cleaned);
    } catch (e) {
      throw new Error('watcher 输出不是合法 JSON: ' + e.message + ' | raw: ' + raw.slice(0, 200));
    }
    const validStatus = ['completed', 'partial', 'stuck', 'need_user', 'failed', 'drifted'];
    // v0.38 P0-A fix: 模型可能输出 "completed | partial | ..."（误把枚举当值）→ 取首项 + trim quote
    if (typeof obj.status === 'string') {
      const candidates = obj.status.split(/[|,]/).map(s => s.trim().replace(/^['"]|['"]$/g, '').toLowerCase());
      const matched = candidates.find(c => validStatus.includes(c));
      if (matched) obj.status = matched;
    }
    if (!validStatus.includes(obj.status)) {
      throw new Error('invalid status: ' + JSON.stringify(obj.status).slice(0, 80));
    }
    // next_action.type 同样容错
    const validActionType = ['continue', 'retry_with_hint', 'review', 'stop', 'escalate_to_user'];
    obj.next_action = obj.next_action || {};
    if (typeof obj.next_action.type === 'string') {
      const candidates = obj.next_action.type.split(/[|,]/).map(s => s.trim().replace(/^['"]|['"]$/g, '').toLowerCase());
      const matched = candidates.find(c => validActionType.includes(c));
      if (matched) obj.next_action.type = matched;
    }
    if (!validActionType.includes(obj.next_action.type)) obj.next_action.type = 'review';
    if (typeof obj.confidence !== 'number' || obj.confidence < 0 || obj.confidence > 1) {
      obj.confidence = 0.5;
    }
    obj.completed_items = Array.isArray(obj.completed_items) ? obj.completed_items : [];
    obj.remaining_items = Array.isArray(obj.remaining_items) ? obj.remaining_items : [];
    obj.next_action.prompt = typeof obj.next_action.prompt === 'string' ? obj.next_action.prompt : '';
    if (!['safe', 'needs_review'].includes(obj.next_action.danger_level)) {
      obj.next_action.danger_level = 'needs_review';
    }
    obj.drift_detected = !!obj.drift_detected;
    obj.reasoning = String(obj.reasoning || '');

    // v0.38 P1: 一致性 sanity check（防止模型恒填高 confidence 但 status 与 items 矛盾）
    if (obj.status === 'completed' && obj.remaining_items.length > 0) {
      obj.confidence = Math.min(obj.confidence, 0.5);
    }
    if (obj.status === 'completed' && obj.completed_items.length === 0) {
      obj.confidence = Math.min(obj.confidence, 0.6);
    }
    if (obj.status === 'partial' && obj.completed_items.length === 0 && obj.remaining_items.length === 0) {
      obj.confidence = Math.min(obj.confidence, 0.3);
    }
    // v0.38 P1: reasoning 中文校验（>60% ASCII 字母视为英文偷懒）
    if (obj.reasoning) {
      const asciiLetters = (obj.reasoning.match(/[A-Za-z]/g) || []).length;
      const total = obj.reasoning.length;
      if (total > 10 && asciiLetters / total > 0.6) {
        obj.reasoning = '（监督者未按要求用中文，原文）' + obj.reasoning;
      }
    }
    return obj;
  }
}
