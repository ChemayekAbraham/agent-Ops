import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: mocks.rpc, storage: { from: mocks.from } } }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
import { AssetRegisterPanel } from '@/components/cfo/assets/AssetRegisterPanel';

const asset = (i: number, over: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-00000000000${i}`,
  asset_code: `WEL-AST-00000${i}`,
  name: `Laptop ${i}`,
  category: 'it_equipment',
  brand: 'Dell', model: 'Latitude', serial_number: `SN-${i}`,
  purchase_date: '2025-01-15', supplier: 'Kampala Computers', purchase_cost: 3500000, currency: 'UGX',
  invoice_reference: 'INV-1', department_key: 'finance', department_name: 'Finance',
  location: 'Head office', custodian_user_id: null, custodian_name: 'Jane', custodian_display: 'Jane',
  condition: 'good', status: 'in_use', photo_paths: [], evidence_paths: [], notes: null, import_batch_id: null,
  created_by: 'u1', created_by_name: 'CFO User', created_at: '2026-10-26T08:00:00Z',
  updated_by: 'u1', updated_by_name: 'CFO User', updated_at: '2026-10-26T08:00:00Z',
  ...over,
});

const summary = {
  as_at: '2026-10-26T08:00:00Z', total_assets: 2, active_assets: 2, register_cost_ugx: 7000000, active_register_cost_ugx: 7000000,
  cost_missing_count: 0, non_ugx_count: 0, missing_evidence_count: 1, missing_photo_count: 2, missing_serial_count: 0, unassigned_count: 0,
  by_status: { in_use: 2 }, by_condition: { good: 2 }, by_category: [{ category: 'it_equipment', count: 2, cost_ugx: 7000000 }],
};

function respond(fn: string, args: Record<string, unknown>) {
  switch (fn) {
    case 'asset_register_summary': return { data: summary, error: null };
    case 'asset_register_reference_data':
      return { data: { departments: [{ key: 'finance', name: 'Finance' }], custodians: [] }, error: null };
    case 'asset_register_list':
      return { data: { total_count: 2, limit: 25, offset: Number(args.p_offset), items: [asset(1), asset(2)] }, error: null };
    case 'asset_register_get':
      return {
        data: {
          asset: asset(1),
          events: [{ id: 'e1', event_type: 'updated', changed_fields: ['status'], old_values: { status: 'in_storage' }, new_values: { status: 'in_use' },
            reason: 'Issued to finance', actor_id: 'u1', actor_name: 'CFO User', batch_id: null, created_at: '2026-10-26T09:00:00Z' }],
        },
        error: null,
      };
    case 'asset_register_create':
      return { data: asset(3, { name: (args.p_asset as Record<string, unknown>).name }), error: null };
    default: return { data: null, error: { message: `unexpected ${fn}` } };
  }
}

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><AssetRegisterPanel /></QueryClientProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rpc.mockImplementation((fn: string, args: Record<string, unknown> = {}) => Promise.resolve(respond(fn, args)));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('CFO Asset Register panel', () => {
  it('shows server overview figures and the register rows', async () => {
    setup();
    expect(await screen.findByText('WEL-AST-000001')).toBeTruthy();
    expect(screen.getByText('Registered assets')).toBeTruthy();
    expect(screen.getByText('Missing evidence')).toBeTruthy();
    expect(screen.getByText(/not a ledger value/)).toBeTruthy();
    expect(screen.getByText('Showing 1–2 of 2')).toBeTruthy();
    expect(mocks.rpc).toHaveBeenCalledWith('asset_register_list', expect.objectContaining({ p_search: null, p_limit: 25, p_offset: 0 }));
  });

  it('sends the search text to the server after a pause', async () => {
    setup();
    await screen.findByText('WEL-AST-000001');
    fireEvent.change(screen.getByLabelText('Search assets'), { target: { value: 'SN-2' } });
    await waitFor(() =>
      expect(mocks.rpc).toHaveBeenCalledWith('asset_register_list', expect.objectContaining({ p_search: 'SN-2', p_offset: 0 })),
    { timeout: 2000 });
  });

  it('opens the asset detail with its audit history', async () => {
    setup();
    fireEvent.click((await screen.findByText('WEL-AST-000001')).closest('tr')!);
    await screen.findByText('History');
    expect(mocks.rpc).toHaveBeenCalledWith('asset_register_get', { p_id: asset(1).id });
    expect(await screen.findByText(/Issued to finance/)).toBeTruthy();
    expect(screen.getByText(/Register information only/)).toBeTruthy();
  });

  it('blocks invalid manual entries in the browser without calling the create RPC', async () => {
    setup();
    await screen.findByText('WEL-AST-000001');
    fireEvent.click(screen.getByRole('button', { name: /Add asset/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Register asset' }));
    expect(await within(dialog).findByText('Name is required')).toBeTruthy();
    expect(mocks.rpc).not.toHaveBeenCalledWith('asset_register_create', expect.anything());

    fireEvent.change(within(dialog).getByLabelText(/Asset name/), { target: { value: 'Office printer' } });
    fireEvent.change(within(dialog).getByLabelText(/Purchase cost/), { target: { value: '-4' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Register asset' }));
    expect(await within(dialog).findByText('Category is required')).toBeTruthy();
    expect(within(dialog).getByText('Site is required')).toBeTruthy();
    expect(within(dialog).getByText(/Purchase cost must be a positive number/)).toBeTruthy();
    expect(mocks.rpc).not.toHaveBeenCalledWith('asset_register_create', expect.anything());
  });

  it('opens the Excel import with a template download and no commit until a file is previewed', async () => {
    setup();
    await screen.findByText('WEL-AST-000001');
    fireEvent.click(screen.getByRole('button', { name: /Import from Excel/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('button', { name: /Download template/ })).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: /^Import \d+ asset/ })).toBeNull();
    expect(mocks.rpc).not.toHaveBeenCalledWith('asset_register_import_commit', expect.anything());
  });

  it('View QR shows the asset QR code and downloads it as <asset code>-qr.png', async () => {
    const clicks: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { clicks.push(this); });
    setup();
    fireEvent.click((await screen.findByText('WEL-AST-000001')).closest('tr')!);
    fireEvent.click(await screen.findByRole('button', { name: /View QR/ }));
    const img = await screen.findByAltText('QR code for WEL-AST-000001');
    expect(img.getAttribute('src')).toMatch(/^data:image\/png;base64,/);
    fireEvent.click(screen.getByRole('button', { name: /Download QR/ }));
    expect(clicks).toHaveLength(1);
    expect(clicks[0].download).toBe('WEL-AST-000001-qr.png');
    expect(clicks[0].href).toBe(img.getAttribute('src'));
  });

  it('Print label opens one label sheet for the asset', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue({} as Window);
    URL.createObjectURL = vi.fn(() => 'blob:labels');
    setup();
    fireEvent.click((await screen.findByText('WEL-AST-000001')).closest('tr')!);
    fireEvent.click(await screen.findByRole('button', { name: /View QR/ }));
    await screen.findByAltText('QR code for WEL-AST-000001');
    fireEvent.click(screen.getByRole('button', { name: /Print label/ }));
    await waitFor(() => expect(open).toHaveBeenCalledWith('blob:labels', '_blank'));
    const blob = (URL.createObjectURL as ReturnType<typeof vi.fn>).mock.calls[0][0] as Blob;
    const pdf = await new Promise<string>((res) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.readAsText(blob); });
    expect(pdf).toContain('WEL-AST-000001');
    expect(pdf).not.toContain('SN-1');
  });

  it('batch-prints labels for the ticked rows without opening the detail', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    URL.createObjectURL = vi.fn(() => 'blob:labels');
    const clicks: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { clicks.push(this); });
    setup();
    await screen.findByText('WEL-AST-000001');
    expect(screen.queryByRole('button', { name: /Print labels/ })).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select WEL-AST-000001' }));
    expect(mocks.rpc).not.toHaveBeenCalledWith('asset_register_get', expect.anything());
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all assets on this page' }));
    fireEvent.click(screen.getByRole('button', { name: 'Print labels (2)' }));
    // pop-up blocked -> the sheet is downloaded instead
    await waitFor(() => expect(open).toHaveBeenCalled());
    await waitFor(() => expect(clicks.some((a) => a.download === 'welile-asset-labels-2.pdf')).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }));
    expect(screen.queryByRole('button', { name: /Print labels/ })).toBeNull();
  });
});

// Tagged assets (WEL-<category>-<site>-<register number>), as issued by the server after 20261027150000.
describe('CFO Asset Register panel with asset tags', () => {
  const tagged = (i: number, tag: string, siteKey: string, siteName: string) =>
    asset(i, { asset_tag: tag, site_key: siteKey, site_name: siteName, location: i === 2 ? 'Front desk' : null });
  const HQ = tagged(1, 'WEL-ICT-HQ-001', 'entebbe_hq', 'Entebbe Head Office');
  const KOL = tagged(2, 'WEL-ICT-KOL-002', 'kololo', 'Kololo');

  beforeEach(() => {
    mocks.rpc.mockImplementation((fn: string, args: Record<string, unknown> = {}) => {
      if (fn === 'asset_register_list') return Promise.resolve({ data: { total_count: 2, limit: 25, offset: 0, items: [HQ, KOL] }, error: null });
      if (fn === 'asset_register_get') {
        const a = args.p_id === KOL.id ? KOL : HQ;
        return Promise.resolve({ data: { asset: a, events: [] }, error: null });
      }
      if (fn === 'asset_register_reference_data') {
        return Promise.resolve({ data: { departments: [], custodians: [], sites: [
          { key: 'entebbe_hq', name: 'Entebbe Head Office', tag_code: 'HQ' }, { key: 'kololo', name: 'Kololo', tag_code: 'KOL' }] }, error: null });
      }
      return Promise.resolve(respond(fn, args));
    });
  });

  const readBlob = (blob: Blob) => new Promise<string>((res) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.readAsText(blob); });

  it('lists each asset by its tag, with the permanent code beneath', async () => {
    setup();
    const tag = await screen.findByText('WEL-ICT-KOL-002', { exact: false });
    const cell = tag.closest('td')!;
    expect(cell.textContent).toBe('WEL-ICT-KOL-002WEL-AST-000002');
    expect(within(cell).getByText('WEL-AST-000002').className).toMatch(/text-\[10px\]/);
    expect(screen.getByRole('checkbox', { name: 'Select WEL-ICT-HQ-001' })).toBeTruthy();
  });

  it('View QR shows the tag, the permanent code and the site, and downloads <tag>-qr.png for that asset', async () => {
    const clicks: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { clicks.push(this); });
    setup();
    fireEvent.click((await screen.findByText('WEL-ICT-KOL-002', { exact: false })).closest('tr')!);
    expect(mocks.rpc).toHaveBeenCalledWith('asset_register_get', { p_id: KOL.id });
    fireEvent.click(await screen.findByRole('button', { name: /View QR/ }));
    const img = await screen.findByAltText('QR code for WEL-ICT-KOL-002');
    const preview = document.getElementById('asset-qr-label-preview')!;
    expect(preview.textContent).toContain('WEL-ICT-KOL-002');
    expect(preview.textContent).toContain('WEL-AST-000002');
    expect(preview.textContent).toContain('Kololo · Front desk');
    fireEvent.click(screen.getByRole('button', { name: /Download QR/ }));
    expect(clicks[0].download).toBe('WEL-ICT-KOL-002-qr.png');
    expect(clicks[0].href).toBe(img.getAttribute('src'));
  });

  it('batch-prints both supplied tags with their permanent codes', async () => {
    vi.spyOn(window, 'open').mockReturnValue({} as Window);
    URL.createObjectURL = vi.fn(() => 'blob:labels');
    setup();
    await screen.findByText('WEL-ICT-HQ-001', { exact: false });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all assets on this page' }));
    fireEvent.click(screen.getByRole('button', { name: 'Print labels (2)' }));
    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalled());
    const pdf = await readBlob((URL.createObjectURL as ReturnType<typeof vi.fn>).mock.calls[0][0] as Blob);
    for (const t of ['(WEL-ICT-HQ-001)', '(WEL-ICT-KOL-002)', '(WEL-AST-000001)', '(WEL-AST-000002)']) expect(pdf).toContain(t);
    expect(pdf).not.toContain('SN-1');
  });

  it('the edit form keeps the tag and says a site change will not alter it', async () => {
    setup();
    fireEvent.click((await screen.findByText('WEL-ICT-HQ-001', { exact: false })).closest('tr')!);
    fireEvent.click(await screen.findByRole('button', { name: /Edit/ }));
    const dialog = await screen.findByRole('dialog', { name: /Edit WEL-ICT-HQ-001/ });
    expect(within(dialog).getByText('Asset tag WEL-ICT-HQ-001 stays the same if the site changes.')).toBeTruthy();
    expect(within(dialog).queryByLabelText(/asset tag/i)).toBeNull(); // no editable tag field
  });
});
