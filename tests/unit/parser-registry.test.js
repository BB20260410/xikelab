import { describe, expect, it } from 'vitest';
import { ParserRegistry, createDefaultParserRegistry, defaultParserRegistry } from '../../src/agents/parsers/ParserRegistry.js';
import { createParserAdapter } from '../../src/agents/parsers/ParserAdapter.js';
import { babelParserAdapter } from '../../src/agents/parsers/BabelParserAdapter.js';

describe('ParserRegistry', () => {
  it('returns the babel adapter for JS/TS/TSX/JSX extensions', () => {
    const reg = createDefaultParserRegistry();
    for (const ext of ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx']) {
      const adapter = reg.getAdapter(ext);
      expect(adapter).toBeTruthy();
      expect(adapter.id).toBe('babel');
    }
  });

  it('is case-insensitive on extension matching', () => {
    expect(defaultParserRegistry.getAdapter('.TS')?.id).toBe('babel');
  });

  it('returns null for unsupported extensions (caller falls back to regex)', () => {
    expect(createDefaultParserRegistry().getAdapter('.py')).toBeNull();
    expect(createDefaultParserRegistry().getAdapter('')).toBeNull();
    expect(createDefaultParserRegistry().getAdapter(null)).toBeNull();
  });

  it('babel adapter parses TS source through the registry without changing analyzer output', () => {
    const adapter = defaultParserRegistry.getAdapter('.ts');
    const out = adapter.parse({ path: 'x.ts', text: 'export const a: number = 1;\nexport function f(): void {}\n' });
    expect(out.ok).toBe(true);
    expect(out.parser).toBe('babel');
    expect(Array.isArray(out.symbols)).toBe(true);
    expect(out.symbols.some((s) => s.name === 'f')).toBe(true);
  });

  it('supports registering additional adapters and prefers the first match', () => {
    const fake = createParserAdapter({ id: 'fake', extensions: ['.foo'], parse: () => ({ ok: true, parser: 'fake' }) });
    const reg = new ParserRegistry([fake, babelParserAdapter]);
    expect(reg.getAdapter('.foo').id).toBe('fake');
    expect(reg.getAdapter('.ts').id).toBe('babel');
    expect(reg.list().map((a) => a.id)).toEqual(['fake', 'babel']);
  });

  it('createParserAdapter validates id and parse', () => {
    expect(() => createParserAdapter({ extensions: ['.x'], parse: () => ({}) })).toThrow();
    expect(() => createParserAdapter({ id: 'noparse', extensions: ['.x'] })).toThrow();
  });

  it('selects the highest-priority adapter for a shared extension, ties keep registration order (D2)', () => {
    const low = createParserAdapter({ id: 'low', extensions: ['.ts'], priority: 0, parse: () => ({ ok: true, parser: 'low' }) });
    const high = createParserAdapter({ id: 'high', extensions: ['.ts'], priority: 10, parse: () => ({ ok: true, parser: 'high' }) });
    // high 后注册仍因 priority 胜出（覆盖既有 adapter 而无需改注册顺序）
    expect(new ParserRegistry([low, high]).getAdapter('.ts').id).toBe('high');
    // 注册顺序相反，结果一致（取决于 priority 而非顺序）
    expect(new ParserRegistry([high, low]).getAdapter('.ts').id).toBe('high');
    // 同 priority → 保持注册顺序（最早者胜）
    const a = createParserAdapter({ id: 'a', extensions: ['.ts'], priority: 5, parse: () => ({}) });
    const b = createParserAdapter({ id: 'b', extensions: ['.ts'], priority: 5, parse: () => ({}) });
    expect(new ParserRegistry([a, b]).getAdapter('.ts').id).toBe('a');
    // 默认 babel adapter priority 为 0
    expect(babelParserAdapter.priority).toBe(0);
  });
});
