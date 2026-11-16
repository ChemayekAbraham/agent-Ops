import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), open: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: mocks.rpc } }));
vi.mock('@/lib/t4RentRequest', async (orig) => ({ ...(await orig<typeof import('@/lib/t4RentRequest')>()), openT4RentRequest: mocks.open }));

import { PostingDraftsList } from '@/components/agent/PostingDraftsList';
import { resetDraftsAvailability } from '@/lib/postingDrafts';

const PAYLOAD = { v: 1, fields: { tenantPhone: '0783 123 456' }, photos: { house: [], tenantPhoto: null, idFront: null, idBack: null, lcLetter: null } };
const ROW = { id: 'd1', tenant_name: 'John Mukasa', tenant_phone: '0783123456', missing: 'Family size, ID photo (back)', expires_at: '2026-11-23T08:00:00Z', payload: PAYLOAD };

const renderList = (onContinue = vi.fn()) => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <PostingDraftsList onContinue={onContinue} />
  </QueryClientProvider>,
);

beforeEach(() => { mocks.rpc.mockReset(); mocks.open.mockReset(); resetDraftsAvailability(); });

describe('E109: Saved list', () => {
  it('shows each saved request with what is missing and when it expires', async () => {
    mocks.rpc.mockResolvedValue({ data: [ROW], error: null });
    renderList();
    expect(await screen.findByText('John Mukasa')).toBeInTheDocument();
    expect(screen.getByText('Missing: Family size, ID photo (back)')).toBeInTheDocument();
    expect(screen.getByText('Expires 23 Nov 2026')).toBeInTheDocument();
    expect(mocks.rpc).toHaveBeenCalledWith('posting_drafts_mine', {});
  });

  it('Continue reopens the chat with the saved payload', async () => {
    mocks.rpc.mockResolvedValue({ data: [ROW], error: null });
    const onContinue = vi.fn();
    renderList(onContinue);
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    expect(onContinue).toHaveBeenCalled();
    expect(mocks.open).toHaveBeenCalledWith({ mode: 'new', entry: 'saved-draft', draft: { id: 'd1', payload: PAYLOAD } });
  });

  it('Remove discards it and takes it off the list', async () => {
    mocks.rpc.mockImplementation(async (fn: string) => (fn === 'posting_drafts_mine' ? { data: [ROW], error: null } : { data: { ok: true }, error: null }));
    renderList();
    fireEvent.click(await screen.findByRole('button', { name: /Remove saved request for John Mukasa/ }));
    await waitFor(() => expect(screen.queryByTestId('posting-drafts')).toBeNull());
    expect(mocks.rpc).toHaveBeenCalledWith('posting_draft_close', { p_draft_id: 'd1', p_status: 'discarded' });
  });

  it('is hidden while the RPC is not on the database', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } });
    const { container } = renderList();
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
