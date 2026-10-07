import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const rpcMock = vi.fn();
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: (...a: unknown[]) => rpcMock(...a) } }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const reviewMutate = vi.fn();
const queue = {
  manager_id: 'mgr-1', is_service_center_manager: true, pending_count: 2, recent_reviewed: [],
  pending: [
    { id: 'rr-1', status: 'service_center_review', created_at: '2026-10-05T08:00:00Z', rent_amount: 300000, duration_days: 30, daily_repayment: 11000,
      total_repayment: 330000, house_category: null, request_city: 'Wakiso', house_image_urls: null, tenant_photo_url: null, tenant_id: 'tenant-1',
      tenant_name: 'Adam Mariam', tenant_phone: '0700111222', agent_id: 'ag-1', agent_name: 'Sub Agent One', agent_phone: '0700999888',
      agent_avatar_url: null, landlord_name: 'Mr Okello', landlord_phone: '0700333444' },
    { id: 'rr-2', status: 'service_center_review', created_at: '2026-10-05T09:00:00Z', rent_amount: 500000, duration_days: 30, daily_repayment: 18000,
      total_repayment: 540000, house_category: null, request_city: 'Kampala', house_image_urls: null, tenant_photo_url: null, tenant_id: 'tenant-2',
      tenant_name: 'Beth Namutebi', tenant_phone: '0700555666', agent_id: 'ag-1', agent_name: 'Sub Agent One', agent_phone: '0700999888',
      agent_avatar_url: null, landlord_name: 'Mrs Auma', landlord_phone: '0700777888' },
  ],
};
vi.mock('@/hooks/useServiceCenterRentQueue', () => ({
  useServiceCenterRentQueue: () => ({ data: queue, isLoading: false, error: null }),
  useServiceCenterReviewRentRequest: () => ({ mutateAsync: (...a: unknown[]) => reviewMutate(...a) }),
}));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { ServiceCenterRentVettingQueue } from './ServiceCenterRentVettingQueue';

const wrapper = ({ children }: { children: ReactNode }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
};
const calls = (fn: string) => rpcMock.mock.calls.filter((c) => c[0] === fn).map((c) => c[1] as Record<string, unknown>);

describe('ServiceCenterRentVettingQueue: awareness call panel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.sessionStorage.clear();
    reviewMutate.mockResolvedValue({});
    rpcMock.mockImplementation((fn: string, args: Record<string, unknown>) => {
      if (fn === 'get_awareness_calls_for_request') return Promise.resolve({ data: { rent_request_id: args.p_rent_request_id, total: 0, rows: [] }, error: null });
      if (fn === 'record_awareness_call') return Promise.resolve({ data: { id: 'c-1', already_recorded: false }, error: null });
      return Promise.resolve({ data: null, error: null });
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('shows the box on every request, suggesting the tenant first', async () => {
    render(<ServiceCenterRentVettingQueue />, { wrapper });
    const boxes = await screen.findAllByTestId('awareness-call-section');
    expect(boxes).toHaveLength(2);
    expect(calls('get_awareness_calls_for_request').map((c) => c.p_rent_request_id).sort()).toEqual(['rr-1', 'rr-2']);
    for (const box of boxes) {
      const links = within(box).getAllByRole('link');
      expect(links[0]).toHaveAttribute('aria-label', expect.stringMatching(/^Call tenant /));
      expect(links[0]).toHaveAttribute('data-suggested', 'true');
    }
    expect(within(boxes[0]).getByRole('link', { name: /Call tenant 0700111222/ })).toHaveAttribute('href', 'tel:0700111222');
    expect(within(boxes[0]).getByRole('link', { name: /Call landlord 0700333444/ })).toHaveAttribute('href', 'tel:0700333444');
  });

  it('records a call against the right request without touching the vetting decision', async () => {
    const user = userEvent.setup();
    render(<ServiceCenterRentVettingQueue />, { wrapper });
    const [first] = await screen.findAllByTestId('awareness-call-section');
    await user.click(within(first).getByRole('button', { name: /Record feedback/ }));
    const form = await within(first).findByRole('form', { name: /Record awareness call feedback/ });
    await user.click(within(form).getByRole('radio', { name: 'Wrong number' }));
    await user.click(within(form).getByRole('button', { name: 'Save call' }));
    await waitFor(() => expect(calls('record_awareness_call')).toHaveLength(1));
    expect(calls('record_awareness_call')[0]).toMatchObject({
      p_rent_request_id: 'rr-1', p_subject_type: 'tenant', p_subject_phone: '0700111222', p_call_result: 'wrong_number', p_subject_user_id: 'tenant-1',
    });
    expect(reviewMutate).not.toHaveBeenCalled();
  });

  it('keeps verify and decline exactly as before: a 10 character comment is still required, and a saved call is not', async () => {
    const user = userEvent.setup();
    render(<ServiceCenterRentVettingQueue />, { wrapper });
    await screen.findAllByTestId('awareness-call-section');
    const verify = screen.getAllByRole('button', { name: /Verify & send to Agent Ops/ })[0];
    const decline = screen.getAllByRole('button', { name: /Decline/ })[0];
    // no awareness call saved, and still nothing blocks the decision except the comment rule
    expect(verify).toBeDisabled();
    expect(decline).toBeDisabled();
    await user.type(screen.getAllByPlaceholderText(/Your comment \(required\)/)[0], 'Checked house and landlord');
    expect(verify).toBeEnabled();
    expect(decline).toBeEnabled();
    await user.click(verify);
    await waitFor(() => expect(reviewMutate).toHaveBeenCalledWith({ requestId: 'rr-1', decision: 'verify', comment: 'Checked house and landlord' }));
  });
});
