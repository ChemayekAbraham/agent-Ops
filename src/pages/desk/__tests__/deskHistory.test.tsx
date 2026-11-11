import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

/** E79: the request's desk history, in the review drawer at every desk and in the search's read-only view. */

const h = vi.hoisted(() => ({ rpc: vi.fn() }));
const fromChain = { select: () => fromChain, eq: () => fromChain, in: () => fromChain, order: () => Promise.resolve({ data: [], error: null }) };
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: (...a: unknown[]) => h.rpc(...a), from: () => fromChain, storage: { from: () => ({ createSignedUrl: async () => ({ data: null, error: null }) }) } },
}));
vi.mock('@/hooks/useIdentityPhotos', () => ({ identityPhotoUrl: async () => null }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u1' }, roles: ['coo'] }) }));
vi.mock('@/hooks/useCrmVoiceCall', () => ({
  useCrmVoiceCall: () => ({ state: 'idle', callId: null, elapsed: 0, error: null, isEnding: false, start: vi.fn(), end: vi.fn() }),
  useHumanCallingPaused: () => ({ data: { paused: false, reason: null, paused_at: null } }),
  isTerminalCallState: () => false,
}));
vi.mock('@/components/coo/CooReasonPicker', () => ({
  useCooReasonPicker: () => ({ picker: null, askReason: vi.fn(), meaningOf: () => null }),
  useCooReasonCodes: () => ({ data: [], isLoading: false }),
}));

import { DeskHistory, timeline, valueText } from '../deskHistory';
import { ReviewDrawer } from '../ReviewDrawer';
import { ReviewStatusProvider } from '../reviewStatus';
import { RequestView, type SearchRow } from '../deskSearch';
import type { Stage } from '../reviewTypes';

const setWidth = (w: number) => Object.defineProperty(window, 'innerWidth', { value: w, configurable: true, writable: true });
afterEach(() => setWidth(1024));

const HISTORY = {
  request: { id: 'r1', short_id: 'r1r1r1r1', status: 'tenant_ops_approved' },
  desks: [
    {
      desk: 'tenant_ops', round: 0, decision: 'pass', system_said: 'pass', followed_system: true, reason: 'Acted as the desk recommended (auto-filled)',
      note: null, score: 100, by: 'Tess Tenantops', staff_id: 'E-021', at: '2026-11-10T10:20:29Z',
      checks: [{ check: 'Rent confirmed', question: 'Rent?', result: 'pass', system_said: null, value: 700000, note: null }],
    },
    {
      desk: 'agent_ops', round: 0, decision: 'send_back', system_said: 'pass', followed_system: false, reason: 'Person overrides the rule on judgement',
      note: 'Photos blurry', score: 60, by: 'Ann Agentops', staff_id: 'E-007', at: '2026-11-10T08:00:00Z',
      checks: [
        { check: 'House photos clear', question: null, result: 'fail', system_said: null, value: null, note: 'blurry' },
        { check: 'Agent performance', question: null, result: 'pass', system_said: 'present', value: null, note: null },
      ],
    },
    {
      desk: 'agent_ops', round: 1, decision: 'pass', system_said: 'pass', followed_system: true, reason: null,
      note: null, score: 90, by: 'Ann Agentops', staff_id: 'E-007', at: '2026-11-10T09:30:00Z', checks: [],
    },
  ],
  calls: [
    { at: '2026-11-10T07:58:49Z', team: 'service_centre', who_called: 'Sarah Caller', subject: 'landlord', result: 'answered', note: null, answers: { aware_30m: 'knew', explained: 'yes', landlord_consent: 'consents', aware_merchant_codes: null } },
  ],
  moves: [
    { at: '2026-11-10T07:01:27Z', from: null, to: 'service_center_review', source: 'app', by: 'Andy Agent' },
    { at: '2026-11-10T10:20:30Z', from: 'agent_ops_approved', to: 'tenant_ops_approved', source: 'review', by: 'Tess Tenantops' },
  ],
  concerns: [{ at: '2026-11-10T09:00:00Z', desk: 'agent_ops', severity: 'serious', category: 'suspected_fraud', note: 'System (E77): photo reused', by: 'System', resolved_at: null }],
  other_actions: [{ at: '2026-11-10T09:10:00Z', action: 'pipeline_tenant_transfer', reason: 'Agent below 50%', by: 'Ann Agentops', detail: {} }],
};

const wrap = (ui: ReactNode) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ReviewStatusProvider>{ui}</ReviewStatusProvider>
    </QueryClientProvider>,
  );

function serve(history: unknown = HISTORY, error?: { message: string }) {
  h.rpc.mockReset();
  h.rpc.mockImplementation((fn: string) => {
    if (fn === 'request_desk_history') return Promise.resolve(error ? { data: null, error } : { data: history, error: null });
    if (fn === 'pipeline_review_sheet')
      return Promise.resolve({
        data: {
          request: {
            id: 'r1', status: 'x', stage: 'tenant_ops', round: 0, rent_amount: 700000, duration_days: 30, created_at: '2026-11-01',
            tenant: { id: 't1', name: 'Odenyo Elly', phone: null, occupation: null }, agent: null, landlord: null, lc1: null, lc_letter: null,
            house_photos: [], gps: null, funder_visible: true,
          },
          checklist: [], history: [], score: null, recommendation: null, can_review: true, my_staff_ref: 'E',
        },
        error: null,
      });
    if (/_list$|_calls$|waiting_list/.test(fn)) return Promise.resolve({ data: [], error: null });
    return Promise.resolve({ data: null, error: null });
  });
}

beforeEach(() => setWidth(1280));

describe('desk history', () => {
  it('one block per desk in pipeline order; each review in time order with who (staff ID) and when, then its checks', async () => {
    serve();
    wrap(<DeskHistory requestId="r1" />);
    await screen.findByText(/Tess Tenantops \(E-021\)/);
    const desks = [...document.querySelectorAll('[data-history-desk]')].map((e) => e.getAttribute('data-history-desk'));
    expect(desks).toEqual(['service_centre', 'agent_ops', 'tenant_ops', 'landlord_ops', 'coo']);

    const ao = screen.getByRole('region', { name: 'Agent Ops' });
    const reviews = within(ao).getAllByText(/Ann Agentops/);
    expect(reviews[0].textContent).toMatch(/^Send back · Ann Agentops \(E-007\) · 10 Nov, 11:00$/);
    expect(reviews[1].textContent).toMatch(/^Pass · round 2 · Ann Agentops \(E-007\) · 10 Nov, 12:30$/);
    expect(within(ao).getByText(/went against it/)).toBeTruthy();
    expect(within(ao).getByText('“Photos blurry”')).toBeTruthy();
    const photo = ao.querySelector('[data-check="House photos clear"]') as HTMLElement;
    expect(photo.textContent).toContain('Fail');
    expect(photo.textContent).toContain('blurry');
    expect((ao.querySelector('[data-check="Agent performance"]') as HTMLElement).textContent).toContain('system saw present');

    const to = screen.getByRole('region', { name: 'Tenant Ops' });
    expect((to.querySelector('[data-check="Rent confirmed"]') as HTMLElement).textContent).toContain('700,000');

    for (const name of ['Service Centre', 'Landlord Ops', 'COO']) {
      expect(within(screen.getByRole('region', { name })).getByText('No review recorded at this desk')).toBeTruthy();
    }
    expect(document.querySelector('[data-history-desk="partner_ops"]')).toBeNull();
  });

  it('calls with their answers; moves, transfers, documents and concerns in one timeline', async () => {
    serve();
    wrap(<DeskHistory requestId="r1" />);
    const calls = await screen.findByRole('region', { name: 'Calls' });
    const call = calls.querySelector('[data-call]') as HTMLElement;
    expect(call.textContent).toContain('landlord');
    expect(call.textContent).toContain('answered');
    expect(call.textContent).toContain('Sarah Caller');
    expect(call.textContent).toContain('aware 30m: knew · explained: yes · landlord consent: consents');
    expect(call.textContent).not.toContain('merchant');

    const items = within(screen.getByRole('list', { name: 'Timeline' })).getAllByRole('listitem').map((li) => li.getAttribute('data-timeline'));
    expect(items).toEqual(['move', 'concern', 'action', 'move']);
    expect(screen.getByText(/Transferred to another agent · Ann Agentops — Agent below 50%/)).toBeTruthy();
    expect(screen.getByText(/Moved from Tenant Ops to Landlord Ops · Tess Tenantops/)).toBeTruthy();
  });

  it('a refusal is shown as-is', async () => {
    serve(HISTORY, { message: "Only desk staff can see a request's desk history" });
    wrap(<DeskHistory requestId="r1" />);
    expect((await screen.findByRole('alert')).textContent).toBe("Only desk staff can see a request's desk history");
  });

  it('values read plainly', () => {
    expect(valueText(700000)).toBe('700,000');
    expect(valueText('Kampala')).toBe('Kampala');
    expect(valueText(null)).toBeNull();
    expect(valueText({ family_size: 4, work: null })).toBe('family size: 4');
    expect(timeline({ moves: [], concerns: [], other_actions: [] })).toEqual([]);
  });
});

describe('the "Desk history" tab in the review drawer, at every desk', () => {
  const STAGES: Stage[] = ['service_centre', 'agent_ops', 'tenant_ops', 'landlord_ops', 'coo'];
  it.each(STAGES)('%s', async (stage) => {
    serve();
    wrap(<ReviewDrawer stage={stage} requestId="r1" onClose={() => {}} />);
    const tabs = await screen.findByRole('tablist', { name: 'Review views' });
    const names = within(tabs).getAllByRole('tab').map((t) => t.textContent);
    expect(names).toEqual(stage === 'agent_ops' ? ['Review', 'Photos', 'Desk history'] : ['Review', 'Desk history']);
    fireEvent.click(within(tabs).getByRole('tab', { name: 'Desk history' }));
    expect(await screen.findByText(/Tess Tenantops \(E-021\)/)).toBeTruthy();
    // The review stays mounted, hidden, so its ticks survive the switch.
    expect(screen.getByText('What the agent sent').closest('.hidden')).toBeTruthy();
  });
});

describe('the read-only view behind COO / Command Centre search', () => {
  it('carries the same desk history', async () => {
    serve();
    const row: SearchRow = {
      id: 'r1', short_id: 'r1r1r1r1', status: 'tenant_ops_approved', desk: 'Landlord Ops', tenant: 'Odenyo Elly', tenant_phone: null,
      agent: 'Andy', agent_phone: null, landlord: 'Lucy', landlord_phone: null, funder: null, rent: 700000, kind: null, matched_on: 'tenant',
    };
    wrap(<RequestView row={row} onClose={() => {}} />);
    const view = screen.getByRole('dialog', { name: 'Odenyo Elly · r1r1r1r1' });
    expect(await within(view).findByText(/Tess Tenantops \(E-021\)/)).toBeTruthy();
    expect(view.querySelector('[data-desk-history]')).toBeTruthy();
  });
});
