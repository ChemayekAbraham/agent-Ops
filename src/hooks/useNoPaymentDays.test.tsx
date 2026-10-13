import { describe, it, expect } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useNoPaymentDays } from './useNoPaymentDays';

const wrap = (url: string) => ({ children }: { children: ReactNode }) => <MemoryRouter initialEntries={[url]}>{children}</MemoryRouter>;
const both = (url: string) => renderHook(() => ({ d: useNoPaymentDays(), loc: useLocation() }), { wrapper: wrap(url) });

describe('useNoPaymentDays', () => {
  it('defaults to 20 and reads ?days=', () => {
    expect(both('/x').result.current.d[0]).toBe(20);
    expect(both('/x?days=45').result.current.d[0]).toBe(45);
    expect(both('/x?days=999').result.current.d[0]).toBe(20);
  });

  it('writes the choice to the URL, keeps other parameters, and leaves the URL clean at the default', () => {
    const { result } = both('/x?wtab=payment-behavior');
    act(() => result.current.d[1](30));
    expect(result.current.d[0]).toBe(30);
    expect(result.current.loc.search).toBe('?wtab=payment-behavior&days=30');
    act(() => result.current.d[1](20));
    expect(result.current.d[0]).toBe(20);
    expect(result.current.loc.search).toBe('?wtab=payment-behavior');
  });

  it('ignores a number outside 1 to 365', () => {
    const { result } = both('/x?days=30');
    act(() => result.current.d[1](0));
    act(() => result.current.d[1](366));
    expect(result.current.d[0]).toBe(30);
  });
});
