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
});
