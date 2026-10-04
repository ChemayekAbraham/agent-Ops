import { describe, it, expect } from 'vitest';
import { isNewerBuild } from './buildUpdate';

const mine = { source: 'aaa', builtAt: '2026-10-01T07:29:30.571Z' };

describe('isNewerBuild', () => {
  it('is true for a different source built later', () => {
    expect(isNewerBuild(mine, { source: 'bbb', builtAt: '2026-10-01T20:35:39.331Z' })).toBe(true);
  });

  it('is false for the same source', () => {
    expect(isNewerBuild(mine, { source: 'aaa', builtAt: '2026-10-02T01:00:00Z' })).toBe(false);
  });

  it('is false for a rollback (different source, older build)', () => {
    expect(isNewerBuild(mine, { source: 'old', builtAt: '2026-09-30T00:00:00Z' })).toBe(false);
  });

  it('is false when either side is unknown or missing', () => {
    expect(isNewerBuild({ source: 'unknown', builtAt: 'unknown' }, { source: 'bbb', builtAt: '2026-10-02T00:00:00Z' })).toBe(false);
    expect(isNewerBuild(mine, { source: null, builtAt: '2026-10-02T00:00:00Z' })).toBe(false);
    expect(isNewerBuild(mine, { source: 'bbb', builtAt: null })).toBe(false);
    expect(isNewerBuild(mine, {})).toBe(false);
  });

  it('is false when a date does not parse', () => {
    expect(isNewerBuild(mine, { source: 'bbb', builtAt: 'not-a-date' })).toBe(false);
  });
});
