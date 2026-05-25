import { describe, expect, it } from 'vitest';
import { buildRoleCardsForMembers, findRoleCard, formatRoleCardForPrompt } from '../../src/room/roleCards.js';

describe('Squad role cards', () => {
  it('builds responsibility/scope/reportTo cards from room members', () => {
    const members = [
      { adapterId: 'claude', displayName: 'Claude PM', role: 'pm' },
      { adapterId: 'codex', displayName: 'Codex Dev', role: 'dev' },
      { adapterId: 'gemini', displayName: 'Gemini QA', role: 'qa' },
    ];
    const cards = buildRoleCardsForMembers(members, { mode: 'squad' });

    expect(cards).toHaveLength(3);
    expect(cards.find((card) => card.role === 'pm')).toMatchObject({ reportTo: null });
    expect(cards.find((card) => card.role === 'dev')).toMatchObject({ reportTo: 'pm' });
    expect(cards.find((card) => card.role === 'qa').scope).toContain('verification');
  });

  it('formats role cards for prompt injection', () => {
    const room = {
      mode: 'squad',
      roleCards: buildRoleCardsForMembers([{ adapterId: 'codex', displayName: 'Codex Dev', role: 'dev' }]),
    };
    const card = findRoleCard(room, { adapterId: 'codex', role: 'dev' });
    const prompt = formatRoleCardForPrompt(card);

    expect(prompt).toContain('角色卡');
    expect(prompt).toContain('职责');
    expect(prompt).toContain('允许范围');
  });
});
