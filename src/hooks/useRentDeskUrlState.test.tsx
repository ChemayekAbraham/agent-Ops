import { describe, it, expect } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useRentDeskUrlState } from './useRentDeskUrlState';

const at = (url: string) => ({ children }: { children: ReactNode }) => <MemoryRouter initialEntries={[url]}>{children}</MemoryRouter>;

const both = (extra: readonly string[] = []) => {
  const state = useRentDeskUrlState(extra);
  const loc = useLocation();
  return { state, search: loc.search };
};

describe('useRentDeskUrlState', () => {
  it('starts at best payers first with no filters', () => {
    const { result } = renderHook(() => both(), { wrapper: at('/desk') });
    expect(result.current.state.sort).toBe('best_payers');
    expect(result.current.state.isFiltered).toBe(false);
    expect(result.current.search).toBe('');
  });

  it('restores the sort and filters from the URL', () => {
    const { result } = renderHook(() => both(), { wrapper: at('/desk?desk_sort=newest&desk_labels=watch&desk_arrived=today') });
    expect(result.current.state.sort).toBe('newest');
    expect(result.current.state.filters).toEqual({ labels: ['watch'], arrived: 'today', from: null, to: null });
    expect(result.current.state.isFiltered).toBe(true);
  });

  it('writes a changed sort and filters to the URL and keeps the other parameters', () => {
    const { result } = renderHook(() => both(), { wrapper: at('/desk?tab=review') });
    act(() => result.current.state.setSort('oldest'));
    act(() => result.current.state.setFilters({ labels: ['proven_good'], arrived: '7d', from: null, to: null }));
    const p = new URLSearchParams(result.current.search);
    expect(p.get('tab')).toBe('review');
    expect(p.get('desk_sort')).toBe('oldest');
    expect(p.get('desk_labels')).toBe('proven_good');
    expect(p.get('desk_arrived')).toBe('7d');
    expect(result.current.state.sort).toBe('oldest');
  });

  it('a filter change keeps the sort, and a sort change keeps the filters', () => {
    const { result } = renderHook(() => both(), { wrapper: at('/desk?desk_sort=oldest') });
    act(() => result.current.state.setFilters({ labels: ['average'], arrived: 'any', from: null, to: null }));
    expect(result.current.state.sort).toBe('oldest');
    act(() => result.current.state.setSort('newest'));
    expect(result.current.state.filters.labels).toEqual(['average']);
  });

  it('clearing the filters removes only the filter parameters', () => {
    const { result } = renderHook(() => both(), { wrapper: at('/desk?tab=review&desk_sort=newest&desk_labels=watch&desk_arrived=custom&desk_from=2026-10-01') });
    act(() => result.current.state.clearFilters());
    const p = new URLSearchParams(result.current.search);
    expect([...p.keys()].sort()).toEqual(['desk_sort', 'tab']);
    expect(result.current.state.isFiltered).toBe(false);
  });

  it('returning to the defaults leaves no desk parameters behind', () => {
    const { result } = renderHook(() => both(), { wrapper: at('/desk?desk_sort=newest') });
    act(() => result.current.state.setSort('best_payers'));
    expect(result.current.search).toBe('');
  });

  it('keeps a desk\'s own extra sorts in the URL too', () => {
    const { result } = renderHook(() => both(['tenant_az']), { wrapper: at('/desk') });
    act(() => result.current.state.setSort('tenant_az'));
    expect(result.current.search).toBe('?desk_sort=tenant_az');
    expect(result.current.state.sort).toBe('tenant_az');
  });
});
