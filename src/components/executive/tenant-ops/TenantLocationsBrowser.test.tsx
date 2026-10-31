import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// The first render loads the whole page module graph; on a busy CI box that can pass 5s.
vi.setConfig({ testTimeout: 30_000 });

const m = vi.hoisted(() => ({
  hits: [] as unknown[],
  generate: vi.fn(),
  multiCalls: [] as unknown[][],
  multiRows: [] as unknown[],
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rpc: vi.fn(),
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { full_name: 'Ops Manager' } }) }) }) }),
  },
}));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u1', email: 'ops@welile.com' } }) }));
vi.mock('@/hooks/useDebouncedValue', () => ({ useDebouncedValue: (v: string) => v }));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/hooks/useTlbPdfExport', () => ({
  useTlbPdfExport: () => ({ state: { phase: 'idle' }, generate: m.generate, deliver: vi.fn(), reset: vi.fn() }),
}));
vi.mock('@/hooks/useTenantLocationsBrowser', async (orig) => ({
  ...(await orig<typeof import('@/hooks/useTenantLocationsBrowser')>()),
  useTlbChildren: () => ({ data: [], isLoading: false }),
  useTlbTenants: () => ({ data: { rows: [], total: 0 }, isLoading: false }),
  useTlbLocationSearch: () => ({ data: m.hits }),
  useTlbTenantsMulti: (...args: unknown[]) => {
    m.multiCalls.push(args);
    const limit = args[3];
    return { data: limit === 1 ? { rows: [], total: 7 } : { rows: m.multiRows, total: m.multiRows.length }, isLoading: false, isFetching: false, error: null };
  },
}));

import { TenantLocationsBrowser } from './TenantLocationsBrowser';

const hit = (label: string, kind: string, over: Record<string, unknown> = {}) => ({
  kind, label, path_label: kind === 'district' ? 'Central' : 'Kisenyi I, Makindye, Kampala', region: 'Central',
  district_id: 7, county_id: kind === 'district' ? null : 70, subcounty_id: kind === 'district' ? null : 700,
  parish_id: kind === 'district' ? null : 7000, village_id: kind === 'village' ? 70000 : null, tenant_count: 12, ...over,
});

const tenant = (id: string, idx: number, active: boolean) => ({
  tenant_id: id, tenant_name: `Tenant ${id}`, tenant_phone: '0700123456', agent_id: null, agent_name: 'Agent A',
  latest_status: 'funded', is_active: active, depth: 6, region: 'Central', district_name: 'Kampala', county_name: null,
  subcounty_name: null, parish_name: null, village_name: 'Kisenyi', legacy_location: null, matched_path_index: idx, total_count: 3,
});

const renderPage = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <TenantLocationsBrowser />
  </QueryClientProvider>,
);

const search = async (user: ReturnType<typeof userEvent.setup>, text: string) => {
  const box = screen.getByPlaceholderText(/search tenant/i);
  await user.clear(box);
  await user.type(box, text);
};

beforeEach(() => {
  sessionStorage.clear();
  m.generate.mockReset();
  m.multiCalls.length = 0;
  m.hits = [hit('Kisenyi', 'village'), hit('Kampala', 'district')];
  m.multiRows = [tenant('a', 0, true), tenant('b', 0, false), tenant('c', 1, true)];
});

describe('TenantLocationsBrowser multi-select', () => {
  it('ticking places shows the sticky bar with place and tenant counts', async () => {
    const user = userEvent.setup();
    renderPage();
    await search(user, 'ki');
    expect(screen.queryByTestId('tlb-selection-bar')).toBeNull();
    await user.click(screen.getByLabelText('Select Kisenyi'));
    await user.click(screen.getByLabelText('Select Kampala'));
    const bar = screen.getByTestId('tlb-selection-bar');
    expect(bar).toHaveTextContent('2 places · 7 tenants');
    expect(within(bar).getByRole('button', { name: /view tenants/i })).toBeInTheDocument();
    expect(within(bar).getByRole('button', { name: /download pdf/i })).toBeInTheDocument();
    expect(within(bar).getByRole('button', { name: /clear/i })).toBeInTheDocument();
  });

  it('tapping the name opens the place and does not select it; checkboxes have 44px tap areas', async () => {
    const user = userEvent.setup();
    renderPage();
    await search(user, 'ki');
    const tick = screen.getByLabelText('Select Kisenyi');
    expect(tick.closest('label')).toHaveClass('h-11', 'w-11');
    await user.click(screen.getByRole('button', { name: /Kisenyi · village/i }));
    expect(screen.queryByTestId('tlb-selection-bar')).toBeNull();
    expect(screen.getByRole('navigation')).toHaveTextContent('Kisenyi');
  });

  it('Select all (N) selects every hit, then offers Deselect all', async () => {
    const user = userEvent.setup();
    renderPage();
    await search(user, 'ki');
    await user.click(screen.getByRole('button', { name: 'Select all (2)' }));
    expect(screen.getByTestId('tlb-selection-bar')).toHaveTextContent('2 places');
    await user.click(screen.getByRole('button', { name: 'Deselect all (2)' }));
    expect(screen.queryByTestId('tlb-selection-bar')).toBeNull();
  });

  it('the selection survives a new search', async () => {
    const user = userEvent.setup();
    renderPage();
    await search(user, 'ki');
    await user.click(screen.getByLabelText('Select Kisenyi'));
    m.hits = [hit('Ntinda', 'village', { village_id: 99 })];
    await search(user, 'nt');
    expect(screen.getByLabelText('Select Ntinda')).not.toBeChecked();
    expect(screen.getByTestId('tlb-selection-bar')).toHaveTextContent('1 place · 7 tenants');
    await user.click(screen.getByLabelText('Select Ntinda'));
    expect(screen.getByTestId('tlb-selection-bar')).toHaveTextContent('2 places');
  });

  it('View tenants groups tenants under each place and the filter applies', async () => {
    const user = userEvent.setup();
    renderPage();
    await search(user, 'ki');
    await user.click(screen.getByRole('button', { name: 'Select all (2)' }));
    await user.click(screen.getByRole('button', { name: /^Active$/ }));
    await user.click(screen.getByRole('button', { name: /view tenants/i }));
    const sections = screen.getAllByTestId('tlb-combined-section');
    expect(sections).toHaveLength(2);
    expect(sections[0]).toHaveTextContent('Kisenyi');
    expect(sections[0]).toHaveTextContent('2 · 1 active · 1 inactive');
    expect(sections[1]).toHaveTextContent('Kampala');
    expect(m.multiCalls.some((c) => c[1] === 'active' && c[3] === undefined)).toBe(true);
    await user.click(screen.getByRole('button', { name: /back to browsing/i }));
    expect(screen.queryByTestId('tlb-combined-view')).toBeNull();
  });

  it('Download PDF hands the selected places, filter and name to the export', async () => {
    const user = userEvent.setup();
    renderPage();
    await search(user, 'ki');
    await user.click(screen.getByLabelText('Select Kisenyi'));
    await user.click(screen.getByRole('button', { name: /download pdf/i }));
    expect(m.generate).toHaveBeenCalledTimes(1);
    const [places, status, by] = m.generate.mock.calls[0];
    expect(places.map((p: { label: string }) => p.label)).toEqual(['Kisenyi']);
    expect(status).toBe('all');
    expect(typeof by).toBe('string');
  });

  it('Clear empties the selection and hides the bar', async () => {
    const user = userEvent.setup();
    renderPage();
    await search(user, 'ki');
    await user.click(screen.getByLabelText('Select Kisenyi'));
    await user.click(screen.getByRole('button', { name: /clear/i }));
    expect(screen.queryByTestId('tlb-selection-bar')).toBeNull();
  });
});
