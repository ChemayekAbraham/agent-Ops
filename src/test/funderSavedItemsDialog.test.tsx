import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
const { load } = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'funder-test' } }) }));
vi.mock('@/components/funder-new/loadFunderSavedItems', () => ({ loadFunderSavedItems: load }));
vi.mock('@/components/agent/EmptyHouseDetailSheet', () => ({ default: () => null }));
vi.mock('@/components/partner/SelfPortfolioPlanDetailSheet', () => ({ SelfPortfolioPlanDetailSheet: () => null }));
import { FunderSavedItemsDialog } from '@/components/funder-new/FunderSavedItemsDialog';
import { useFunderSavedItems } from '@/hooks/useFunderSavedItems';
import { FUNDER_SAVED_KEY } from '@/lib/funderSavedItems';
const availableHouse = { category: 'empty', item: { house_id: 'house-1', title: 'Test house', house_category: 'Single Room', monthly_rent: 100000, district: 'Kampala', verified: true } };
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><FunderSavedItemsDialog open onOpenChange={vi.fn()} /></QueryClientProvider>);
}
function readSaved() { return JSON.parse(localStorage.getItem(FUNDER_SAVED_KEY) ?? '{}'); }
describe('Saved Items dialog', () => {
  beforeEach(() => { localStorage.clear(); load.mockReset(); });
  it('retains available bookmarks and removes taken items from browser storage', async () => {
    localStorage.setItem(FUNDER_SAVED_KEY, JSON.stringify({ empty: ['house-1', 'taken-house'], ready: ['taken-plan'] }));
    load.mockResolvedValue([availableHouse]);
    mount();
    await waitFor(() => expect(readSaved()).toEqual({ empty: ['house-1'], ready: [] }));
    await userEvent.click(await screen.findByRole('button', { name: /Remove .* from saved items/ }));
    await waitFor(() => expect(readSaved()).toEqual({ empty: [], ready: [] }));
  });
  it('keeps bookmarks when availability fails', async () => {
    const saved = { empty: ['keep-house'], ready: ['keep-plan'] };
    localStorage.setItem(FUNDER_SAVED_KEY, JSON.stringify(saved));
    load.mockRejectedValue(new Error('Network unavailable'));
    mount();
    await waitFor(() => expect(load).toHaveBeenCalled());
    await screen.findByRole('button', { name: 'Try again' });
    expect(readSaved()).toEqual(saved);
  });
  it('shares bookmark changes between mounted consumers and after remount', async () => {
    function Control() {
      const { saved, toggleSave } = useFunderSavedItems();
      return <button onClick={() => toggleSave('empty', 'house-1')}>{saved.empty.length}</button>;
    }
    const first = render(<><Control /><Control /></>);
    await userEvent.click(screen.getAllByRole('button', { name: '0' })[0]);
    expect(screen.getAllByRole('button', { name: '1' })).toHaveLength(2);
    first.unmount();
    render(<Control />);
    expect(screen.getByRole('button', { name: '1' })).toBeTruthy();
  });
  it('preserves a bookmark added while an availability read is running', async () => {
    localStorage.setItem(FUNDER_SAVED_KEY, JSON.stringify({ empty: ['old-house'], ready: [] }));
    let finish: ((entries: unknown[]) => void) | undefined;
    load.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; })).mockResolvedValue([]);
    mount();
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    act(() => {
      localStorage.setItem(FUNDER_SAVED_KEY, JSON.stringify({ empty: ['old-house', 'new-house'], ready: [] }));
      window.dispatchEvent(new StorageEvent('storage', { key: FUNDER_SAVED_KEY }));
      finish?.([]);
    });
    // The first read must not remove a newly saved ID. Its own later read can resolve availability.
    expect(readSaved().empty).toContain('new-house');
  });
});