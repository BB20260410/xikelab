import { describe, it, expect } from 'vitest';
import { flushPendingMirrors, get, set, subscribe } from '../../../public/src/web/state.js';

describe('PanelStore state helpers', () => {
  it('set/get supports dotted paths and subscribe notifications', () => {
    const seen = [];
    const unsubscribe = subscribe((event) => seen.push(event));
    set('testState.value', 42);
    unsubscribe();

    expect(get('testState.value')).toBe(42);
    expect(seen.at(-1)).toMatchObject({
      path: 'testState.value',
      newValue: 42,
    });
  });

  it('flushPendingMirrors replays app.js mirror writes queued before main.js loads', () => {
    const target = {
      __panelPendingStateMirrors: [
        { path: 'archive.list', value: ['queued-archive'] },
        { path: 'plugin.activeId', value: 'plugin-1' },
        { path: null, value: 'ignored' },
      ],
    };

    expect(flushPendingMirrors(target)).toBe(2);
    expect(target.__panelPendingStateMirrors).toHaveLength(0);
    expect(get('archive.list')).toEqual(['queued-archive']);
    expect(get('plugin.activeId')).toBe('plugin-1');
  });
});
