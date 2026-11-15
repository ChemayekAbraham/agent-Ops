import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';

const rpcMock = vi.fn();
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: (...a: unknown[]) => rpcMock(...a), from: vi.fn(), storage: { from: vi.fn() } },
}));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u1' }, roles: ['coo'] }) }));

import { ConcernsTab } from '../concerns/ConcernsTab';
import { ageText, filterRows, linkTarget, parseConcernsQueue, ugxFull } from '../concerns/concernsQueueApi';
import { DeskTabs } from '../DeskTabs';

const setWidth = (w: number) => Object.defineProperty(window, 'innerWidth', { value: w, configurable: true, writable: true });
afterEach(() => setWidth(1024));
beforeEach(() => rpcMock.mockReset());

const ROW = (i: number, over: Record<string, unknown> = {}) => ({
  source: 'payout_dispute', source_label: 'Payout dispute', item_id: `p${i}`, ref: `PD-00${i}`, title: `Landlord not paid ${i}`, about: 'Tenant Achieng · Kireka',
  owner_name: 'Agnes Namata', parked_at: 'Financial Ops', status: 'open', is_open: true, opened_at: '2026-11-10T08:00:00Z', due_at: '2026-11-12T08:00:00Z',
  severity: 'serious', money_ugx: 1_250_000, priority: 1, link_path: `/desk/financial-ops?dispute=p${i}`, age_days: 6.2, overdue: true, ...over,
});
const QUEUE = (over: Record<string, unknown> = {}) => ({
  generated_at: '2026-11-16T08:00:00Z',
  open_total: 42,
  overdue_total: 7,
  logged_per_day_8wk: 3.25,
  by_source: [
    { source: 'payout_dispute', label: 'Payout dispute', open: 5, overdue: 3, money_ugx: 6_000_000 },
    { source: 'desk_concern', label: 'Desk concern', open: 30, overdue: 4, money_ugx: null },
  ],
  by_parked: [
    { parked_at: 'Financial Ops', open: 5, overdue: 3 },
    { parked_at: 'Tenant Ops', open: 12, overdue: 0 },
  ],
  rows: [
    ROW(1),
    ROW(2, { source: 'desk_concern', source_label: 'Desk concern', title: 'Story changed between calls', money_ugx: null, overdue: false, due_at: null, link_path: '/desk/tenant-ops?request=r2', parked_at: 'Tenant Ops' }),
  ],
  ...over,
});

function Where() {
  const l = useLocation();
  return <span data-testid="where">{l.pathname + l.search}</span>;
}
const wrap = (ui: ReactNode) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/desk/command']}>
        <Routes>
          <Route path="*" element={<>{ui}<Where /></>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );

describe('Concerns queue: reading the server', () => {
  it('parses the queue, keeping the server order and leaving unknown money empty', () => {
    const q = parseConcernsQueue(QUEUE());
    expect(q).toMatchObject({ open_total: 42, overdue_total: 7, logged_per_day_8wk: 3.25 });
    expect(q.rows.map((r) => r.key)).toEqual(['payout_dispute:p1', 'desk_concern:p2']);
    expect(q.rows[1].money_ugx).toBeNull();
    expect(parseConcernsQueue(null)).toMatchObject({ open_total: 0, rows: [], by_source: [] });
  });
  it('words: money, age, overdue filter and where a row opens', () => {
    expect(ugxFull(1_250_000)).toBe('UGX 1,250,000');
    expect(ugxFull(null)).toBeNull();
    expect(ageText(6.24)).toBe('6.2 days');
    expect(ageText(0.3)).toBe('today');
    const rows = parseConcernsQueue(QUEUE()).rows;
    expect(filterRows(rows, true).map((r) => r.key)).toEqual(['payout_dispute:p1']);
    expect(linkTarget('/desk/x')).toEqual({ internal: true, href: '/desk/x' });
    expect(linkTarget('https://crm.example/1')).toEqual({ internal: false, href: 'https://crm.example/1' });
    expect(linkTarget(null)).toBeNull();
  });
});

describe('Command Centre → Concerns', () => {
  const mock = (q = QUEUE()) => rpcMock.mockImplementation((fn: string, args: Record<string, unknown>) => Promise.resolve(fn === 'concerns_queue' ? { data: args.p_source ? { ...q, rows: q.rows.filter((r) => r.source === args.p_source) } : q, error: null } : { data: null, error: null }));

  it('top figures, chips per source and where it is parked', async () => {
    setWidth(1280);
    mock();
    wrap(<ConcernsTab board={false} />);
    await screen.findByText('Landlord not paid 1');
    expect(rpcMock).toHaveBeenCalledWith('concerns_queue', { p_scope: 'open', p_source: null, p_limit: 500 });
    expect(document.querySelector('[data-figure="Open"]')?.textContent).toBe('42');
    expect(document.querySelector('[data-figure="Overdue"]')?.textContent).toBe('7');
    expect(document.querySelector('[data-figure="Logged per day (8 weeks)"]')?.textContent).toBe('3.25');
    const chip = document.querySelector('[data-source="payout_dispute"]') as HTMLElement;
    expect(chip.textContent).toContain('Payout dispute');
    expect(chip.textContent).toContain('5');
    expect(chip.textContent).toContain('3 overdue');
    expect(chip.textContent).toContain('UGX 6,000,000');
    expect([...document.querySelectorAll('[data-parked] li')].map((li) => li.textContent)).toEqual(['Financial Ops5 open3 overdue', 'Tenant Ops12 open']);
  });

  it('rows: source, ref, title, about, owner, parked at, age, due, red Overdue and money; a tap opens link_path', async () => {
    setWidth(1280);
    mock();
    wrap(<ConcernsTab board={false} />);
    const row = (await screen.findByText('Landlord not paid 1')).closest('[data-concern]') as HTMLElement;
    expect(row.getAttribute('data-overdue')).toBe('true');
    for (const t of ['Payout dispute', 'Tenant Achieng · Kireka', 'Agnes Namata', 'UGX 1,250,000', '6.2 days', '12 Nov 2026', 'Overdue']) expect(row.textContent).toContain(t);
    fireEvent.click(within(row).getByText('Landlord not paid 1'));
    expect(screen.getByTestId('where').textContent).toBe('/desk/financial-ops?dispute=p1');
  });

  it('the Overdue and source badges open the same explanation panel as the desks', async () => {
    setWidth(1280);
    mock();
    wrap(<ConcernsTab board={false} />);
    await screen.findByText('Landlord not paid 1');
    fireEvent.click(screen.getByRole('button', { name: 'Overdue: what it means' }));
    const panel = screen.getByRole('dialog', { name: 'Overdue: what it means' });
    expect(panel.textContent).toContain('Due 12 Nov 2026 and still open.');
    fireEvent.click(screen.getAllByRole('button', { name: 'Payout dispute: about this concern' })[0]);
    const about = screen.getByRole('dialog', { name: 'Payout dispute: about this concern' });
    expect(about.textContent).toContain('Parked at Financial Ops');
    // A sheet, not a popover: a table cell clips anything that overflows it. A tap inside never opens the row.
    fireEvent.click(within(about).getByText('Tenant Achieng · Kireka'));
    expect(screen.getByTestId('where').textContent).toBe('/desk/command');
  });

  it('filters: a source chip asks the server for that source; Open/All changes the scope; Overdue only trims the rows', async () => {
    setWidth(1280);
    mock();
    wrap(<ConcernsTab board={false} />);
    await screen.findByText('Story changed between calls');
    await act(async () => {
      fireEvent.click(document.querySelector('[data-source="desk_concern"]') as HTMLElement);
    });
    await waitFor(() => expect(rpcMock).toHaveBeenCalledWith('concerns_queue', { p_scope: 'open', p_source: 'desk_concern', p_limit: 500 }));
    await waitFor(() => expect(screen.queryByText('Landlord not paid 1')).toBeNull());
    // The other source chips stay, so picking one never hides the rest.
    expect(document.querySelector('[data-source="payout_dispute"]')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'All sources' }));
    await screen.findByText('Landlord not paid 1');
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    await waitFor(() => expect(rpcMock).toHaveBeenCalledWith('concerns_queue', { p_scope: 'all', p_source: null, p_limit: 500 }));
    fireEvent.click(screen.getByRole('button', { name: 'Overdue only' }));
    await waitFor(() => expect(screen.queryByText('Story changed between calls')).toBeNull());
    expect(screen.getByText('Landlord not paid 1')).toBeTruthy();
  });

  it('phone: rows are cards', async () => {
    setWidth(375);
    mock();
    wrap(<ConcernsTab board={false} />);
    await screen.findByText('Landlord not paid 1');
    expect(document.querySelector('table')).toBeNull();
    expect(document.querySelectorAll('li[data-concern]').length).toBe(2);
  });

  it('a refused viewer sees a plain line, not an error dump', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { code: '42501', message: 'Not allowed to view the Concerns queue' } });
    wrap(<ConcernsTab board={false} />);
    expect(await screen.findByText('You are not allowed to see the Concerns queue.')).toBeTruthy();
  });
});

describe('the count chip on the Command centre tab', () => {
  it('shows the open count after the desk name; nothing while unknown', () => {
    const desks = [{ id: 'command', name: 'Command centre' }, { id: 'coo', name: 'COO' }];
    const a = render(<MemoryRouter><DeskTabs desks={desks} activeId="coo" board={false} counts={{ command: 42 }} /></MemoryRouter>);
    const tab = a.container.querySelector('[data-desk-tab="command"]') as HTMLElement;
    expect(tab.textContent).toBe('Command centre42');
    expect(a.container.querySelector('[data-desk-tab="coo"] [data-tab-count]')).toBeNull();
    a.unmount();
    const b = render(<MemoryRouter><DeskTabs desks={desks} activeId="coo" board={false} counts={{ command: null }} /></MemoryRouter>);
    expect(b.container.querySelector('[data-tab-count]')).toBeNull();
  });
});
