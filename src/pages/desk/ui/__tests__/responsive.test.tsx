import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/* A supabase stub that answers the staff-ID lookup (hr_staff) with one row. */
const chain: Record<string, unknown> = {};
for (const m of ['select', 'eq', 'order']) chain[m] = () => chain;
chain.limit = () => Promise.resolve({ data: [{ staff_ref: 'EMP-042' }], error: null });
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: vi.fn(() => new Promise(() => {})), from: () => chain, storage: { from: vi.fn() }, functions: { invoke: vi.fn() } },
}));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u1' }, roles: ['coo'] }) }));

import {
  BREAKPOINTS,
  DataList,
  Segmented,
  abbreviateMoney,
  breakpointFor,
  daysShort,
  moneyCard,
  moneyFull,
  pctWhole,
  plainReason,
  splitDecisionLabel,
  type DataColumn,
} from '..';
import { DeskHeader } from '../../DeskPage';
import { DeskPrefsProvider } from '../../deskPrefs';

const setWidth = (w: number) => Object.defineProperty(window, 'innerWidth', { value: w, configurable: true, writable: true });
afterEach(() => setWidth(1024));

type Row = { id: string; tenant: string; agent: string; rent: number; note: string };
const ROWS: Row[] = Array.from({ length: 14 }, (_, i) => ({ id: `r${i}`, tenant: `Tenant ${i}`, agent: i === 3 ? 'Okello' : `Agent ${i}`, rent: 100_000 * (i + 1), note: `Note ${i}` }));
const COLS: DataColumn<Row>[] = [
  { key: 'tenant', label: 'Tenant', priority: 1, render: (r) => r.tenant },
  { key: 'rent', label: 'Rent', priority: 1, render: (r) => moneyCard(r.rent), align: 'right' },
  { key: 'agent', label: 'Agent', priority: 2, render: (r) => r.agent },
  { key: 'note', label: 'Note', priority: 3, render: (r) => r.note },
];

/* ───────────── DataList ───────────── */

describe('DataList', () => {
  it('is a table from md (600 px) up and a card list below', () => {
    setWidth(600);
    const { unmount } = render(<DataList label="requests" columns={COLS} rows={ROWS} rowKey={(r) => r.id} />);
    expect(document.querySelector('[data-layout="table"]')).not.toBeNull();
    expect(document.querySelector('th')?.style.position).toBe('sticky');
    unmount();
    setWidth(599);
    render(<DataList label="requests" columns={COLS} rows={ROWS} rowKey={(r) => r.id} />);
    expect(document.querySelector('[data-layout="cards"]')).not.toBeNull();
    expect(document.querySelector('table')).toBeNull();
  });

  it('cards: priority 1 always, priority 2 as a small line, priority 3 only under More', () => {
    render(<DataList label="requests" columns={COLS} rows={ROWS} rowKey={(r) => r.id} forceLayout="cards" />);
    const card = document.querySelector('li[data-row="r0"]') as HTMLElement;
    expect(within(card).getByText('Tenant 0')).toBeTruthy();
    expect(within(card).getByText('UGX 100K')).toBeTruthy();
    expect(within(card).getByText(/Agent 0/)).toBeTruthy();
    expect(within(card).queryByText('Note 0')).toBeNull();
    fireEvent.click(within(card).getByRole('button', { name: 'More' }));
    expect(within(card).getByText('Note 0')).toBeTruthy();
  });

  it('shows 10, then all; search filters; empty state', () => {
    render(<DataList label="requests" columns={COLS} rows={ROWS} rowKey={(r) => r.id} forceLayout="table" />);
    expect(document.querySelectorAll('tbody tr')).toHaveLength(10);
    fireEvent.click(screen.getByRole('button', { name: 'Show all 14' }));
    expect(document.querySelectorAll('tbody tr')).toHaveLength(14);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search requests' }), { target: { value: 'okello' } });
    expect(document.querySelectorAll('tbody tr')).toHaveLength(1);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search requests' }), { target: { value: 'nobody' } });
    expect(screen.getByText('No requests match "nobody".')).toBeTruthy();
  });

  it('long text clamps to two lines with the whole text in a tooltip', () => {
    render(<DataList label="requests" columns={COLS} rows={ROWS.slice(0, 1)} rowKey={(r) => r.id} forceLayout="table" />);
    const clamp = screen.getByText('Note 0') as HTMLElement;
    expect(clamp.style.webkitLineClamp || clamp.style.getPropertyValue('-webkit-line-clamp')).toBe('2');
    expect(clamp.getAttribute('title')).toBe('Note 0');
  });
});

/* ───────────── Segmented ───────────── */

describe('Segmented', () => {
  const opts = ['Today', '7 days', '30 days', '90 days', 'All time'].map((l, i) => ({ value: ['today', '7d', '30d', '90d', 'all'][i], label: l }));

  it('never wraps: one row that scrolls sideways', () => {
    setWidth(390);
    render(<Segmented ariaLabel="Period" options={opts} value="30d" onChange={() => {}} />);
    const row = screen.getByRole('group', { name: 'Period' });
    expect(row.style.flexWrap).toBe('nowrap');
    expect(row.style.overflowX).toBe('auto');
    for (const b of within(row).getAllByRole('button')) expect(b.style.flexShrink).toBe('0');
  });

  it('below 360 px it is a native select', () => {
    setWidth(320);
    const onChange = vi.fn();
    render(<Segmented ariaLabel="Period" options={opts} value="30d" onChange={onChange} />);
    const select = screen.getByRole('combobox', { name: 'Period' }) as HTMLSelectElement;
    expect(select.value).toBe('2');
    fireEvent.change(select, { target: { value: '4' } });
    expect(onChange).toHaveBeenCalledWith('all');
    expect(screen.queryByRole('group', { name: 'Period' })).toBeNull();
  });
});

/* ───────────── header and switcher ───────────── */

const DESK = { id: 'agent-ops', name: 'Agent Ops' };
const TWO = [DESK, { id: 'coo', name: 'COO' }];

function mountHeader(bp: 'xs' | 'sm' | 'md' | 'lg' | 'xl', allowed = TWO) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={['/desk/agent-ops']}>
      <QueryClientProvider client={qc}>
        <DeskPrefsProvider>
          <div className="desk-root">
            <DeskHeader desk={DESK} allowed={allowed} updated={0} failed={[]} board={false} bp={bp} />
          </div>
        </DeskPrefsProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('desk header', () => {
  it('below md: one bar of at most 56 px, the moved controls in the ⋯ menu, no Board mode', async () => {
    mountHeader('sm');
    const bar = document.querySelector('[data-desk-header="compact"]') as HTMLElement;
    expect(bar.style.maxHeight).toBe('56px');
    expect(bar.style.position).toBe('sticky');
    expect(screen.queryByRole('button', { name: /board mode/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Desk options' }));
    const menu = screen.getByRole('dialog', { name: 'Desk options' });
    expect(within(menu).getByRole('button', { name: /Refresh/ })).toBeTruthy();
    expect(within(menu).getByRole('button', { name: /Switch to the dark theme/ })).toBeTruthy();
    expect(within(menu).getByRole('button', { name: /Rows:/ })).toBeTruthy();
    expect(await within(menu).findByText('EMP-042')).toBeTruthy();
  });

  it('md: tabs as today, density and staff ID in ⋯, Board mode only from lg', () => {
    const { unmount } = mountHeader('md');
    expect(document.querySelector('[data-desk-header="full"]')).not.toBeNull();
    expect(screen.getByRole('navigation', { name: 'Desks' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /board mode/i })).toBeNull();
    expect(screen.getByRole('button', { name: 'Desk options' })).toBeTruthy();
    unmount();
    mountHeader('lg');
    expect(screen.getByRole('button', { name: /Enter board mode/ })).toBeTruthy();
  });

  it('the switcher lists the desks below md, and is not there with one desk', () => {
    const { unmount } = mountHeader('sm');
    fireEvent.click(screen.getByRole('button', { name: 'Desk: Agent Ops. Switch desk' }));
    const sheet = screen.getByRole('dialog', { name: 'Switch desk' });
    expect(within(sheet).getAllByRole('link').map((a) => a.textContent)).toEqual(['Agent Ops', 'COO']);
    unmount();
    mountHeader('sm', [DESK]);
    expect(document.querySelector('[data-desk-switcher]')).toBeNull();
    expect(screen.getByText('Agent Ops')).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Desks' })).toBeNull();
  });
});

/* ───────────── helpers ───────────── */

describe('formatting and reasons', () => {
  it('days, money and percentages', () => {
    expect(daysShort(152.4)).toBe('152 d');
    expect(daysShort(0.3)).toBe('<1 d');
    expect(daysShort(null)).toBe('—');
    expect(moneyCard(1_234_567)).toBe('UGX 1.2M');
    expect(moneyFull(1_234_567)).toBe('UGX 1,234,567');
    expect(pctWhole(64.6)).toBe('65%');
    expect(abbreviateMoney('UGX 59,200,000')).toEqual({ short: 'UGX 59.2M', full: 'UGX 59,200,000' });
    expect(abbreviateMoney('113')).toEqual({ short: '113', full: null });
  });

  it('rule codes leave the sentence and go to the tooltip', () => {
    expect(plainReason('AO-6: agent grade D; move to Receiver')).toEqual({ text: 'Agent grade D; move to Receiver', codes: ['AO-6'] });
    expect(plainReason('All checks pass (SC-1)').text).toBe('All checks pass');
    expect(plainReason('On hold COO-HOLD for FinOps').codes).toEqual(['COO-HOLD']);
  });

  it('primary labels stay ≤24 characters; the target moves under the button', () => {
    expect(splitDecisionLabel('Transfer → Kato James (B, 2.4 km)')).toEqual({ label: 'Transfer', detail: 'Kato James (B, 2.4 km)' });
    expect(splitDecisionLabel('Pass')).toEqual({ label: 'Pass', detail: null });
    const long = splitDecisionLabel('Call the landlord before you pass this one');
    expect(long.label.length).toBeLessThanOrEqual(24);
    expect(long.detail).toBe('Call the landlord before you pass this one');
  });

  it('breakpoints: one source, and index.css uses the same numbers', () => {
    expect(BREAKPOINTS).toEqual({ xs: 0, sm: 360, md: 600, lg: 1024, xl: 1440, wall: 1920 });
    expect([320, 360, 599, 600, 1023, 1024, 1440, 1920].map(breakpointFor)).toEqual(['xs', 'sm', 'sm', 'md', 'md', 'lg', 'xl', 'wall']);
    const css = readFileSync(resolve(__dirname, '../../../../index.css'), 'utf8');
    const block = css.slice(css.indexOf('Responsive foundation'), css.indexOf('/* ---- The same board in daylight'));
    expect(block).toContain('(min-width: 600px)');
    expect(block).toContain('(max-width: 599.98px)');
    expect(block).toContain('(min-width: 1920px)');
  });
});
