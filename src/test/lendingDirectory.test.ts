import { describe, expect, it } from 'vitest';
import { lendingDirectoryRange } from '@/lib/lendingDirectory';

describe('lending directory pagination', () => {
  it('shows exactly five users on each page', () => {
    expect(lendingDirectoryRange(0)).toEqual([0, 4]);
    expect(lendingDirectoryRange(1)).toEqual([5, 9]);
    expect(lendingDirectoryRange(2)).toEqual([10, 14]);
  });
});