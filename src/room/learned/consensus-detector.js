// consensus-detector — 检测对话是否达成共识（学自 W5 AutoGen TextMessageTermination）
// 独立 helper，未接入 DebateDispatcher——等 sprint 级独立设计

const CONSENSUS_KEYWORDS = [
  // 中文
  '达成共识', '达成一致', '完全同意', '我同意', '一致认为',
  '没有异议', '共识已经', '可以总结', '总结一下',
  // 英文
  'reached consensus', 'we agree', 'i agree', 'all agree',
  'no objections', 'we can conclude', 'in conclusion',
];

const DISAGREEMENT_KEYWORDS = [
  '我不同意', '不一致', '反对', '有异议',
  'disagree', 'object', 'i differ',
];

/**
 * 检测最后 N 个 turn 是否表明共识
 * @param {Array<{speaker, content}>} turns  最近的 turn 列表（旧→新）
 * @param {object} opts
 * @param {number} [opts.window=3]      检查最后几个 turn
 * @param {number} [opts.minAgreed=2]   至少 N 个 turn 显示同意才算共识
 * @returns {{ consensus: boolean, score: number, evidence: string[] }}
 */
export function detectConsensus(turns, opts = {}) {
  if (!Array.isArray(turns) || turns.length === 0) {
    return { consensus: false, score: 0, evidence: [] };
  }
  const window = opts.window ?? 3;
  const minAgreed = opts.minAgreed ?? 2;
  const recent = turns.slice(-window);

  let agreed = 0;
  let disagreed = 0;
  const evidence = [];

  for (const turn of recent) {
    const text = (turn.content || '').toLowerCase();
    const matchedConsensus = CONSENSUS_KEYWORDS.find(kw => text.includes(kw.toLowerCase()));
    const matchedDisagree = DISAGREEMENT_KEYWORDS.find(kw => text.includes(kw.toLowerCase()));

    if (matchedConsensus && !matchedDisagree) {
      agreed++;
      evidence.push(`[${turn.speaker || '?'}] 命中 "${matchedConsensus}"`);
    } else if (matchedDisagree) {
      disagreed++;
      evidence.push(`[${turn.speaker || '?'}] 命中分歧 "${matchedDisagree}"`);
    }
  }

  const consensus = agreed >= minAgreed && disagreed === 0;
  const score = (agreed - disagreed) / recent.length;

  return { consensus, score, evidence };
}

/**
 * 适合 DebateDispatcher 在每轮结束调用：
 *   const { consensus } = detectConsensus(round.turns);
 *   if (consensus) {
 *     // 提前终止，跳过剩余 round，让主持人直接合成 finalConsensus
 *     return finalizeEarly(...);
 *   }
 */
