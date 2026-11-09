/**
 * Partner Returns Phase 5, PartnerImportDialog data code (design v2 §6.1): the rate column may be
 * blank (sent as no rate, the database gate decides), "Returns %" is read as the rate header, the
 * request carries policy_enabled_seen, and a 409 POLICY_CHANGED shows the reload message.
 *
 * Switch-off parity: a typed rate goes out exactly as before (roiPercentage per portfolio).
 */
import type { ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  invoke: vi.fn(),
  rows: [] as Record<string, unknown>[],
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rpc: mocks.rpc,
    functions: { invoke: mocks.invoke },
    from: () => ({ select: () => ({ in: async () => ({ data: [], error: null }) }) }),
  },
}));
vi.mock('sonner', () => ({ toast: { error: mocks.toastError, success: mocks.toastSuccess } }));
vi.mock('xlsx', () => ({
  read: () => ({ SheetNames: ['Partners'], Sheets: { Partners: {} } }),
  utils: { sheet_to_json: () => mocks.rows },
}));

import PartnerImportDialog from '@/components/coo/PartnerImportDialog';
import { POLICY_CHANGED_MESSAGE } from '@/lib/staffPortfolioRate';

function route(enabled: boolean) {
  mocks.rpc.mockImplementation(async (fn: string) =>
    fn === 'get_partner_return_policy'
      ? { data: { enabled, new_contract_rate: enabled ? 10 : 15 }, error: null }
      : { data: null, error: null });
}

function renderDialog() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  return render(<PartnerImportDialog open onOpenChange={() => {}} />, { wrapper: Wrapper });
}

const policyReads = () => mocks.rpc.mock.calls.filter(([fn]) => fn === 'get_partner_return_policy').length;

async function importRows(rows: Record<string, unknown>[]) {
  mocks.rows = rows;
  renderDialog();
  await waitFor(() => expect(policyReads()).toBeGreaterThan(0));
  const file = new File(['x'], 'partners.xlsx');
  Object.defineProperty(file, 'arrayBuffer', { value: async () => new ArrayBuffer(1) });
  const input = document.getElementById('partner-import-file-input') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [file] } });
  fireEvent.click(await screen.findByRole('button', { name: /review & confirm/i }));
  fireEvent.click(await screen.findByRole('button', { name: /confirm & import/i }));
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalled());
  return mocks.invoke.mock.calls[0][1].body as {
    partners: { portfolios: { roiPercentage: number | null }[] }[];
    policy_enabled_seen: boolean;
  };
}

beforeEach(() => {
  localStorage.clear();
  mocks.rpc.mockReset();
  mocks.invoke.mockReset();
  mocks.toastError.mockReset();
  mocks.toastSuccess.mockReset();
  mocks.invoke.mockResolvedValue({ data: { partnersCreated: 1, partnersMatched: 0, portfoliosCreated: 1, errors: [] }, error: null });
});

const row = (rate: unknown, header = 'ROI %') => ({
  'Partner Name': 'Test Partner', Phone: '0700123456', 'Investment Amount': 500000, [header]: rate, 'Duration (Months)': 12,
});

describe('PartnerImportDialog: Returns rate column', () => {
  it('switch seen off, typed rate: sent as today, policy_enabled_seen false (parity)', async () => {
    route(false);
    const body = await importRows([row(15)]);
    expect(body.partners[0].portfolios[0].roiPercentage).toBe(15);
    expect(body.policy_enabled_seen).toBe(false);
  });

  it('a blank rate is allowed and sent as no rate (null), never a guessed 15', async () => {
    route(true);
    const body = await importRows([row('')]);
    expect(body.partners[0].portfolios[0].roiPercentage).toBeNull();
  });

  it('a missing rate column is allowed too', async () => {
    route(true);
    const r = row(undefined);
    delete (r as Record<string, unknown>)['ROI %'];
    const body = await importRows([r]);
    expect(body.partners[0].portfolios[0].roiPercentage).toBeNull();
  });

  it('"Returns %" is read as the rate header; switch seen on -> policy_enabled_seen true', async () => {
    route(true);
    const body = await importRows([row(12, 'Returns %')]);
    expect(body.partners[0].portfolios[0].roiPercentage).toBe(12);
    expect(body.policy_enabled_seen).toBe(true);
  });

  it("a typed rate outside today's 1-30 stays refused", async () => {
    route(false);
    mocks.rows = [row(45)];
    renderDialog();
    await waitFor(() => expect(policyReads()).toBeGreaterThan(0));
    const file = new File(['x'], 'partners.xlsx');
    Object.defineProperty(file, 'arrayBuffer', { value: async () => new ArrayBuffer(1) });
    fireEvent.change(document.getElementById('partner-import-file-input') as HTMLInputElement, { target: { files: [file] } });
    const next = await screen.findByRole('button', { name: /review & confirm/i });
    expect((next as HTMLButtonElement).disabled).toBe(true);
  });

  it('409 POLICY_CHANGED: the reload message, and the policy is read again', async () => {
    route(false);
    const res = new Response(JSON.stringify({ code: 'POLICY_CHANGED', error: 'x' }), { status: 409 });
    mocks.invoke.mockResolvedValue({ data: null, error: { message: 'non-2xx', context: res } });
    const before = 1;
    await importRows([row(15)]);
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith(POLICY_CHANGED_MESSAGE));
    await waitFor(() => expect(policyReads()).toBeGreaterThan(before));
  });
});
