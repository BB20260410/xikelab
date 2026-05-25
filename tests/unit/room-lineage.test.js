import { describe, expect, it } from 'vitest';
import { sanitizeLineage, sanitizeObjective } from '../../src/room/RoomLineage.js';

describe('RoomLineage helpers', () => {
  it('sanitizes objective and lineage metadata', () => {
    const objective = sanitizeObjective({
      title: 'Build budget controls',
      description: 'Track cost and stop over-budget work',
      acceptanceCriteria: ['80% warning', '100% hard stop'],
    });
    expect(objective.id).toMatch(/^obj-/);
    expect(objective.status).toBe('active');
    expect(objective.acceptanceCriteria).toHaveLength(2);

    const lineage = sanitizeLineage({ parentRoomId: 'room-parent', taskId: 'T1' }, { projectId: '/tmp/project' });
    expect(lineage).toMatchObject({
      projectId: '/tmp/project',
      parentRoomId: 'room-parent',
      taskId: 'T1',
      source: 'manual',
    });
  });
});
