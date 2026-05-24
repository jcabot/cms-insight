import { describe, expect, it } from 'vitest';
import { computeDigraph } from './digraph.js';

describe('computeDigraph', () => {
  it('counts in/out degree per node', () => {
    const s = computeDigraph(
      ['a', 'b', 'c'],
      [
        { source: 'a', target: 'b' },
        { source: 'a', target: 'c' },
        { source: 'b', target: 'c' },
      ],
    );
    expect(s.degreeById.get('a')).toEqual({ in: 0, out: 2 });
    expect(s.degreeById.get('b')).toEqual({ in: 1, out: 1 });
    expect(s.degreeById.get('c')).toEqual({ in: 2, out: 0 });
  });

  it('derives orphan and isolated totals', () => {
    const s = computeDigraph(
      ['a', 'b', 'lonely'],
      [{ source: 'a', target: 'b' }],
    );
    expect(s.orphansNoIn).toBe(2); // a, lonely
    expect(s.orphansNoOut).toBe(2); // b, lonely
    expect(s.isolated).toBe(1); // lonely
  });

  it('deduplicates repeated edges per ordered pair', () => {
    const s = computeDigraph(
      ['a', 'b'],
      [
        { source: 'a', target: 'b' },
        { source: 'a', target: 'b' },
      ],
    );
    expect(s.edges).toEqual([{ source: 'a', target: 'b' }]);
    expect(s.degreeById.get('b')?.in).toBe(1);
  });

  it('keeps both directions of a pair as distinct edges', () => {
    const s = computeDigraph(
      ['a', 'b'],
      [
        { source: 'a', target: 'b' },
        { source: 'b', target: 'a' },
      ],
    );
    expect(s.edges).toHaveLength(2);
  });

  it('drops edges whose endpoints are not known nodes', () => {
    const s = computeDigraph(
      ['a'],
      [
        { source: 'a', target: 'ghost' },
        { source: 'ghost', target: 'a' },
      ],
    );
    expect(s.edges).toHaveLength(0);
    expect(s.degreeById.get('a')).toEqual({ in: 0, out: 0 });
  });
});
