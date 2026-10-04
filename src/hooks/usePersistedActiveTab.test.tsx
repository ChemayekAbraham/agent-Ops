import { describe, it, expect, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { usePersistedActiveTab } from './usePersistedActiveTab';

const wrapperFor = (path: string) => {
  return ({ children }: { children: React.ReactNode }) => (
    <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>
  );
};

describe('usePersistedActiveTab — Platform Impact persistence', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('falls back to the default tab when nothing is stored', () => {
    const { result } = renderHook(() => usePersistedActiveTab('cfo'), {
      wrapper: wrapperFor('/cfo/dashboard'),
    });
    expect(result.current[0]).toBe('overview');
  });

  it('writes the active tab to localStorage under a role+route scoped key', () => {
    const { result } = renderHook(() => usePersistedActiveTab('cfo'), {
      wrapper: wrapperFor('/cfo/dashboard'),
    });

    act(() => {
      result.current[1]('platform-impact');
    });

    expect(result.current[0]).toBe('platform-impact');
    expect(
      window.localStorage.getItem('dashboard:cfo:/cfo/dashboard:activeTab'),
    ).toBe('platform-impact');
  });

  it('restores platform-impact on reload from localStorage', () => {
    window.localStorage.setItem(
      'dashboard:cfo:/cfo/dashboard:activeTab',
      'platform-impact',
    );

    const { result } = renderHook(() => usePersistedActiveTab('cfo'), {
      wrapper: wrapperFor('/cfo/dashboard'),
    });

    expect(result.current[0]).toBe('platform-impact');
  });

  it('isolates storage by role so admin and cfo do not collide', () => {
    window.localStorage.setItem(
      'dashboard:cfo:/cfo/dashboard:activeTab',
      'platform-impact',
    );

    const { result } = renderHook(() => usePersistedActiveTab('admin'), {
      wrapper: wrapperFor('/cfo/dashboard'),
    });

    expect(result.current[0]).toBe('overview');
  });

  it('isolates storage by route so different dashboards keep their own tab', () => {
    window.localStorage.setItem(
      'dashboard:cfo:/cfo/dashboard:activeTab',
      'platform-impact',
    );

    const { result } = renderHook(() => usePersistedActiveTab('cfo'), {
      wrapper: wrapperFor('/cfo/other'),
    });

    expect(result.current[0]).toBe('overview');
  });

  it('syncs across tabs when a storage event fires for the same key', () => {
    const { result } = renderHook(() => usePersistedActiveTab('cfo'), {
      wrapper: wrapperFor('/cfo/dashboard'),
    });

    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'dashboard:cfo:/cfo/dashboard:activeTab',
          newValue: 'platform-impact',
          storageArea: window.localStorage,
        }),
      );
    });

    expect(result.current[0]).toBe('platform-impact');
  });

  it('resets to default when the storage key is cleared in another tab', () => {
    window.localStorage.setItem(
      'dashboard:cfo:/cfo/dashboard:activeTab',
      'platform-impact',
    );
    const { result } = renderHook(() => usePersistedActiveTab('cfo'), {
      wrapper: wrapperFor('/cfo/dashboard'),
    });
    expect(result.current[0]).toBe('platform-impact');

    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'dashboard:cfo:/cfo/dashboard:activeTab',
          newValue: null,
          storageArea: window.localStorage,
        }),
      );
    });

    expect(result.current[0]).toBe('overview');
  });

  it('restores the section from a ?section= deep link (URL wins over storage)', () => {
    window.localStorage.setItem(
      'dashboard:cfo:/cfo/dashboard:activeTab',
      'overview',
    );

    const { result } = renderHook(() => usePersistedActiveTab('cfo'), {
      wrapper: wrapperFor('/cfo/dashboard?section=platform-impact'),
    });

    expect(result.current[0]).toBe('platform-impact');
  });
});