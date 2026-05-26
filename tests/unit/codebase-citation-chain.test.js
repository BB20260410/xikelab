import { describe, expect, it } from 'vitest';
import { citationPathsFromGraph } from '../../src/agents/CodebaseCitationChain.js';

describe('citationPathsFromGraph readable path', () => {
  it('renders a human-readable route -> handler -> service -> test chain', () => {
    const graph = {
      routeTestChains: [
        {
          route: 'POST /api/x',
          testPath: 'tests/unit/routes/x.test.js',
          testLine: 5,
          path: [
            { kind: 'route-definition', path: 'src/routes/x.js', line: 12, label: 'createX' },
            { kind: 'service-call', path: 'src/store/XStore.js', line: 30, label: 'XStore.create' },
          ],
        },
      ],
    };
    const paths = citationPathsFromGraph(graph);
    expect(paths).toHaveLength(1);
    expect(paths[0].kind).toBe('route-to-test');
    expect(paths[0].readable).toBe(
      'route POST /api/x -> createX (x.js:12) -> XStore.create (XStore.js:30) -> test x.test.js:5'
    );
    expect(paths[0].steps).toHaveLength(2);
  });

  it('handles chains without intermediate steps and missing lines', () => {
    const graph = {
      routeTestChains: [
        { route: 'GET /api/y', testPath: 'y.test.js', path: [] },
      ],
    };
    const paths = citationPathsFromGraph(graph);
    expect(paths[0].readable).toBe('route GET /api/y -> test y.test.js:?');
  });

  it('returns empty for graphs without route-test chains', () => {
    expect(citationPathsFromGraph({})).toEqual([]);
    expect(citationPathsFromGraph({ routeTestChains: [] })).toEqual([]);
  });
});
