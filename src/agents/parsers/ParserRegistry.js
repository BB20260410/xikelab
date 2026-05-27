// Parser registry（P0-A）：按扩展名选择 parser adapter，未命中返回 null（调用方走 regex fallback）。
import { babelParserAdapter } from './BabelParserAdapter.js';

export class ParserRegistry {
  constructor(adapters = []) {
    this.adapters = [...adapters];
  }

  register(adapter) {
    if (adapter) this.adapters.push(adapter);
    return this;
  }

  getAdapter(ext) {
    const e = String(ext || '').toLowerCase();
    let best = null;
    for (const a of this.adapters) {
      if (!a.supports(e)) continue;
      // 高 priority 优先；同 priority 保持注册顺序（严格大于才替换 → 最早注册者胜）
      if (!best || (a.priority || 0) > (best.priority || 0)) best = a;
    }
    return best;
  }

  list() {
    return this.adapters.map((a) => ({ id: a.id, extensions: a.extensions }));
  }
}

export function createDefaultParserRegistry() {
  return new ParserRegistry([babelParserAdapter]);
}

export const defaultParserRegistry = createDefaultParserRegistry();
