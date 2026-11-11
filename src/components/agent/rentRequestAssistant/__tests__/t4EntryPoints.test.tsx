import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AgentRejectedRequest } from '@/hooks/useAgentRejectedRequests';

const mocks = vi.hoisted(() => ({ rejected: [] as unknown[], refetch: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: vi.fn(), from: vi.fn() } }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ signOut: vi.fn() }) }));
vi.mock('@/hooks/useAgentRejectedRequests', () => ({
  useAgentRejectedRequests: () => ({ data: mocks.rejected, isLoading: false, refetch: mocks.refetch }),
}));
// The host lazy-loads the form; a stub shows which request it was given.
vi.mock('@/components/agent/rentRequestAssistant/RentRequestAssistant', () => ({
  default: ({ request, onOpenChange }: { request: { mode: string; entry?: string }; onOpenChange: (o: boolean) => void }) => (
    <div data-testid="t4-form">
      {request.mode}:{request.entry}
      <button type="button" onClick={() => onOpenChange(false)}>Close T4</button>
    </div>
  ),
}));

import { closeT4RentRequest, getT4Request, openT4RentRequest } from '@/lib/t4RentRequest';
import T4RentRequestHost from '@/components/agent/rentRequestAssistant/T4RentRequestHost';
import { AgentRejectedRequestsSection } from '@/components/agent/AgentRejectedRequestsSection';
import { AgentHubDrawer } from '@/components/agent/AgentHubDrawer';

beforeAll(() => {
  Element.prototype.scrollTo = vi.fn() as unknown as typeof Element.prototype.scrollTo;
});
afterEach(() => act(() => closeT4RentRequest()));

const wrap = (ui: React.ReactNode) => (
  <QueryClientProvider client={new QueryClient()}>
    <MemoryRouter>{ui}</MemoryRouter>
  </QueryClientProvider>
);

const rejectedRequest = {
  id: 'req-9', rent_amount: 300000, duration_days: 30, number_of_payments: 4, daily_repayment: 14000,
  total_repayment: 420000, access_fee: 1, request_fee: 1, status: 'rejected', created_at: '2026-11-01T08:00:00Z',
  rejected_at: '2026-11-02T08:00:00Z', rejected_at_stage: 'service_center', rejected_reason: 'LC1 letter is blurred',
  reopen_count: 1, tenant_id: 'tenant-1', landlord_id: 'll-1', tenant_water_meter: null, tenant_electricity_meter: null,
  request_latitude: null, request_longitude: null, lc1_id: null, house_category: 'single-room', preferred_language: 'English',
  tenant_no_smartphone: false, registration_type: 'agent_registered', initial_outstanding_balance: null,
  outstanding_grace_days: null, house_image_urls: [], lc_letter_path: null, lc_letter_bucket: null,
  tenant_ops_reviewed_by: null, tenant_ops_reviewed_at: null, agent_verified_by: null, agent_verified_at: null,
  landlord_ops_reviewed_by: null, landlord_ops_reviewed_at: null, coo_reviewed_by: null, coo_reviewed_at: null,
  cfo_reviewed_by: null, cfo_reviewed_at: null, tenant_name: 'John Mukasa', tenant_phone: '0783123456',
  landlord_name: 'Peter Okello', stage_label: 'Service Centre',
} as AgentRejectedRequest;

describe('T4RentRequestHost: one form, wherever the agent is', () => {
  it('shows the T4 form for whatever opened it, and closes it', async () => {
    render(wrap(<T4RentRequestHost />));
    expect(screen.queryByTestId('t4-form')).toBeNull();
    act(() => openT4RentRequest({ mode: 'resubmit', rejected: rejectedRequest, entry: 'rejected-requests' }));
    expect(await screen.findByTestId('t4-form')).toHaveTextContent('resubmit:rejected-requests');
    fireEvent.click(screen.getByRole('button', { name: 'Close T4' }));
    await waitFor(() => expect(screen.queryByTestId('t4-form')).toBeNull());
    expect(getT4Request()).toBeNull();
  });

  it('the older open-rent-request event (deep links, widgets) opens the same form', async () => {
    render(wrap(<T4RentRequestHost />));
    act(() => { window.dispatchEvent(new CustomEvent('open-rent-request')); });
    expect(await screen.findByTestId('t4-form')).toHaveTextContent('new:open-rent-request-event');
  });
});

describe('old entry points open T4', () => {
  it('Edit/Resubmit on a rejected request opens T4 in resubmit mode with that request', () => {
    mocks.rejected = [rejectedRequest];
    render(wrap(<AgentRejectedRequestsSection />));
    fireEvent.click(screen.getByRole('button', { name: /resubmit/i }));
    expect(getT4Request()).toMatchObject({ mode: 'resubmit', entry: 'rejected-requests', rejected: { id: 'req-9' } });
    // After the resubmit the list refreshes.
    act(() => getT4Request()?.onDone?.('req-9'));
    expect(mocks.refetch).toHaveBeenCalled();
  });

  it('"Post a rent request" is first in the agent hub menu and opens a new T4 request', async () => {
    render(wrap(<AgentHubDrawer open onClose={vi.fn()} />));
    const items = screen.getAllByRole('button').map((b) => b.textContent?.trim()).filter(Boolean);
    const first = items.findIndex((t) => /Post a rent request/.test(t ?? ''));
    expect(first).toBeGreaterThanOrEqual(0);
    expect(items.slice(0, first).some((t) => /Pay Rent|Issue Receipt/.test(t ?? ''))).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: /Post a rent request/ }));
    await waitFor(() => expect(getT4Request()).toMatchObject({ mode: 'new', entry: 'agent-hub-drawer' }));
  });

  // Big screens (dashboards, tenant sheets, profile, listings) are checked at the source:
  // each opens T4 with the right mode, and none can reach an old form any more.
  const src = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
  const ENTRY_POINTS: [file: string, opens: RegExp[]][] = [
    ['src/components/dashboards/AgentDashboardBk.tsx', [/openT4RentRequest\(\{ mode: 'new', entry: 'agent-dashboard' \}\)/]],
    ['src/pages/AgentDashboardNew.tsx', [/openT4RentRequest\(\{ mode: 'new', entry: 'agent-dashboard-new' \}\)/]],
    ['src/components/DashboardHeader.tsx', [/openT4RentRequest\(\{ mode: 'new', entry: 'agent-menu' \}\)/]],
    ['src/components/agent/AgentTenantsSheet.tsx', [/mode: 'new', entry: 'tenants-sheet-post'/, /mode: 'renewal',\s+entry: 'tenants-sheet'/]],
    ['src/components/agent-bk/AgentTenantsSheet.tsx', [/mode: 'new', entry: 'tenants-sheet-bk-post'/, /mode: 'renewal',\s+entry: 'tenants-sheet-bk'/]],
    ['src/components/agent/TenantProfileView.tsx', [/mode: 'renewal',\s+entry: 'tenant-profile-renew'/]],
    ['src/components/agent/AgentListingsSheet.tsx', [/mode: 'new', entry: 'swap-tenant', [^\n]*prefill: \{ house:/]],
    ['src/components/agent/TenantRentIntakeQueue.tsx', [/mode: 'new',\s+entry: 'tenant-intake-queue',\s+prefill:/]],
    ['src/components/agent/AgentRejectedRequestsSection.tsx', [/mode: 'resubmit', rejected: req, entry: 'rejected-requests'/]],
    ['src/components/agent/AgentRequestPipelineView.tsx', [/mode: 'resubmit', rejected: r, entry: 'request-pipeline'/]],
  ];

  it.each(ENTRY_POINTS)('%s opens T4 and no old form', (file, opens) => {
    const code = src(file);
    for (const re of opens) expect(code).toMatch(re);
    expect(code).not.toMatch(/import[^;]*AgentRentRequestDialog/);
    expect(code).not.toMatch(/import[^;]*AgentEditRentRequestDialog/);
    expect(code).not.toMatch(/<AgentRentRequestDialog\b|<AgentEditRentRequestDialog\b/);
    expect(code).not.toMatch(/renew_rent_request/);
  });

  it('the renewal server call now lives only in the T4 submit path', () => {
    expect(src('src/lib/t4RentRequestSubmit.ts')).toMatch(/rpc\('renew_rent_request'/);
  });
});
