import { describe, it, expect } from 'vitest';
import {
  DEFAULT_RENT_DESK_SORT,
  NO_RENT_DESK_FILTERS,
  cleanRentDeskDay,
  isRentDeskFiltered,
  normalizeRentDeskFilters,
  readRentDeskUrl,
  rentDeskFilterArgs,
  writeRentDeskUrl,
} from './rentDeskFilters';

const q = (s: string) => new URLSearchParams(s);

describe('reading the desk state from the URL', () => {
  it('defaults to best payers first with no filters', () => {
    const s = readRentDeskUrl(q(''));
    expect(s.sort).toBe(DEFAULT_RENT_DESK_SORT);
    expect(s.filters).toEqual(NO_RENT_DESK_FILTERS);
  });

  it('reads the sort, labels, arrival and custom range', () => {
    const s = readRentDeskUrl(q('desk_sort=oldest&desk_labels=watch,proven_good&desk_arrived=custom&desk_from=2026-10-01&desk_to=2026-10-14'));
    expect(s.sort).toBe('oldest');
    expect(s.filters).toEqual({ labels: ['proven_good', 'watch'], arrived: 'custom', from: '2026-10-01', to: '2026-10-14' });
  });

  it('ignores anything unknown or malformed', () => {
    const s = readRentDeskUrl(q('desk_sort=cheapest&desk_labels=gold,watch,watch&desk_arrived=yesterday&desk_from=nope'));
    expect(s.sort).toBe('best_payers');
    expect(s.filters).toEqual({ labels: ['watch'], arrived: 'any', from: null, to: null });
  });

  it('drops impossible calendar days and puts a reversed range the right way round', () => {
    expect(cleanRentDeskDay('2026-02-30')).toBeNull();
    expect(cleanRentDeskDay('2026-10-14')).toBe('2026-10-14');
    const s = readRentDeskUrl(q('desk_arrived=custom&desk_from=2026-10-14&desk_to=2026-10-01'));
    expect(s.filters).toMatchObject({ from: '2026-10-01', to: '2026-10-14' });
  });

  it('lets a desk add sorts of its own', () => {
    expect(readRentDeskUrl(q('desk_sort=tenant_az'), ['tenant_az']).sort).toBe('tenant_az');
    expect(readRentDeskUrl(q('desk_sort=tenant_az')).sort).toBe('best_payers');
  });

  it('keeps the range days only for a custom range', () => {
    const s = readRentDeskUrl(q('desk_arrived=7d&desk_from=2026-10-01&desk_to=2026-10-14'));
    expect(s.filters).toEqual({ labels: [], arrived: '7d', from: null, to: null });
  });
});

describe('writing the desk state to the URL', () => {
  it('leaves the defaults out', () => {
    expect(writeRentDeskUrl(q(''), { sort: 'best_payers', filters: NO_RENT_DESK_FILTERS }).toString()).toBe('');
  });

  it('never touches parameters the desk does not own', () => {
    const next = writeRentDeskUrl(q('tab=review&days=30'), {
      sort: 'newest',
      filters: { labels: ['watch'], arrived: 'today', from: null, to: null },
    });
    expect(next.get('tab')).toBe('review');
    expect(next.get('days')).toBe('30');
    expect(next.get('desk_sort')).toBe('newest');
    expect(next.get('desk_labels')).toBe('watch');
    expect(next.get('desk_arrived')).toBe('today');
  });

  it('removes the desk parameters again when cleared', () => {
    const on = writeRentDeskUrl(q('tab=review'), { sort: 'oldest', filters: { labels: ['average'], arrived: '7d', from: null, to: null } });
    const off = writeRentDeskUrl(on, { sort: 'best_payers', filters: NO_RENT_DESK_FILTERS });
    expect(off.toString()).toBe('tab=review');
  });

  it('round-trips every choice', () => {
    const state = {
      sort: 'oldest' as const,
      filters: { labels: ['proven_good', 'good_agent_pick'] as const, arrived: 'custom' as const, from: '2026-09-30', to: null },
    };
    const url = writeRentDeskUrl(q(''), { sort: state.sort, filters: { ...state.filters, labels: [...state.filters.labels] } });
    expect(readRentDeskUrl(url)).toEqual({ sort: 'oldest', filters: { labels: ['proven_good', 'good_agent_pick'], arrived: 'custom', from: '2026-09-30', to: null } });
  });
});

describe('what counts as filtered, and what the server is asked', () => {
  it('a label or a dated arrival narrows the desk; a custom range with no day yet does not', () => {
    expect(isRentDeskFiltered(NO_RENT_DESK_FILTERS)).toBe(false);
    expect(isRentDeskFiltered({ ...NO_RENT_DESK_FILTERS, labels: ['watch'] })).toBe(true);
    expect(isRentDeskFiltered({ ...NO_RENT_DESK_FILTERS, arrived: 'today' })).toBe(true);
    expect(isRentDeskFiltered({ ...NO_RENT_DESK_FILTERS, arrived: '7d' })).toBe(true);
    expect(isRentDeskFiltered({ ...NO_RENT_DESK_FILTERS, arrived: 'custom' })).toBe(false);
    expect(isRentDeskFiltered({ ...NO_RENT_DESK_FILTERS, arrived: 'custom', to: '2026-10-14' })).toBe(true);
  });

  it('sends nothing for no filter, and only the chosen parts otherwise', () => {
    expect(rentDeskFilterArgs(NO_RENT_DESK_FILTERS)).toEqual({ p_labels: null, p_arrived: null, p_from: null, p_to: null });
    expect(rentDeskFilterArgs({ labels: ['watch'], arrived: '7d', from: '2026-10-01', to: null })).toEqual({
      p_labels: ['watch'], p_arrived: '7d', p_from: null, p_to: null,
    });
    expect(rentDeskFilterArgs({ labels: [], arrived: 'custom', from: '2026-10-01', to: '2026-10-14' })).toEqual({
      p_labels: null, p_arrived: 'custom', p_from: '2026-10-01', p_to: '2026-10-14',
    });
    expect(rentDeskFilterArgs({ labels: [], arrived: 'custom', from: null, to: null }).p_arrived).toBeNull();
  });

  it('orders and de-duplicates labels', () => {
    expect(normalizeRentDeskFilters({ labels: ['watch', 'proven_good', 'watch'] }).labels).toEqual(['proven_good', 'watch']);
  });
});
