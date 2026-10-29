import { describe, expect, it } from 'vitest';
import { parseFunderSaved, reconcileFunderSaved, toggleFunderSaved } from '@/lib/funderSavedItems';

describe('browser saved houses and Rent Plans', () => {
  it('restores locally saved houses and Rent Plans without duplicates', () => {
    expect(parseFunderSaved('{"empty":["house-1","house-1",4],"ready":["plan-1"]}')).toEqual({ empty: ['house-1'], ready: ['plan-1'] });
  });
  it('toggles only the chosen category and persists as browser JSON', () => {
    const saved = toggleFunderSaved({ empty: ['house-1'], ready: ['plan-1'] }, 'ready', 'plan-2');
    expect(parseFunderSaved(JSON.stringify(saved))).toEqual({ empty: ['house-1'], ready: ['plan-1', 'plan-2'] });
    expect(toggleFunderSaved(saved, 'empty', 'house-1')).toEqual({ empty: [], ready: ['plan-1', 'plan-2'] });
  });
  it('removes taken houses and Rent Plans after successful complete availability checks', () => {
    expect(reconcileFunderSaved({ empty: ['available-house', 'taken-house'], ready: ['taken-plan', 'available-plan'] }, { empty: ['available-house'], ready: ['available-plan'] })).toEqual({ empty: ['available-house'], ready: ['available-plan'] });
  });
  it('does not replace unchanged saved state', () => {
    const saved = { empty: ['house-1'], ready: [] };
    expect(reconcileFunderSaved(saved, { empty: ['house-1', 'house-2'], ready: [] })).toBe(saved);
  });
  it('tolerates malformed browser storage', () => {
    expect(parseFunderSaved('{bad')).toEqual({ empty: [], ready: [] });
    expect(parseFunderSaved('null')).toEqual({ empty: [], ready: [] });
  });
});