// LoopGuard — 4 道熔断防 claude 失控
// 移植自 思维镜 Safety/LoopGuard.swift
// 触发任一条件即返回 BreakReason，调用方需立即 kill child + 通知前端

export const DEFAULT_LOOP_GUARD_CONFIG = {
  maxStepsPerTask: 30,
  maxRepeatedInstructions: 3,
  costSurgeWindowMs: 5 * 60 * 1000,
  costSurgeThresholdUSD: 0.5,
  maxFileChurnIn10Min: 8,
};

export class LoopGuard {
  constructor(config = {}) {
    this.cfg = { ...DEFAULT_LOOP_GUARD_CONFIG, ...config };
    this.stepsThisTask = 0;
    this.recentInstructions = [];
    this.recentFileChanges = [];
  }

  recordInstruction(text) {
    this.stepsThisTask++;
    if (this.stepsThisTask > this.cfg.maxStepsPerTask) {
      return { type: 'steps_exceeded', current: this.stepsThisTask, max: this.cfg.maxStepsPerTask };
    }
    const now = Date.now();
    this.recentInstructions.push({ text, at: now });
    if (this.recentInstructions.length > 10) {
      this.recentInstructions = this.recentInstructions.slice(-10);
    }
    const last = this.recentInstructions.slice(-this.cfg.maxRepeatedInstructions);
    if (
      last.length === this.cfg.maxRepeatedInstructions &&
      last.every(i => i.text === text)
    ) {
      return { type: 'repeated_instruction', text: text.slice(0, 200), count: last.length };
    }
    return null;
  }

  recordCost(usdInWindow) {
    // v0.49 N-36 fix: caller 传的是 CostTracker.windowUSD(5min)——已经是窗口累计值，
    // 这里直接和阈值比，不再 push+reduce（之前双重累计：累计窗口 × 调用次数）
    if (usdInWindow > this.cfg.costSurgeThresholdUSD) {
      return {
        type: 'cost_surge',
        usdInWindow: Math.round(usdInWindow * 100) / 100,
        threshold: this.cfg.costSurgeThresholdUSD,
      };
    }
    return null;
  }

  recordFileChange(file) {
    const now = Date.now();
    this.recentFileChanges.push({ file, at: now });
    this.recentFileChanges = this.recentFileChanges.filter(c => now - c.at < 10 * 60 * 1000);
    const churn = this.recentFileChanges.filter(c => c.file === file).length;
    if (churn > this.cfg.maxFileChurnIn10Min) {
      return { type: 'file_churn', file, churnCount: churn };
    }
    return null;
  }

  resetTask() {
    this.stepsThisTask = 0;
  }

  snapshot() {
    return {
      stepsThisTask: this.stepsThisTask,
      recentInstructionsCount: this.recentInstructions.length,
      churnedFiles: this.recentFileChanges.length,
      config: this.cfg,
    };
  }
}
