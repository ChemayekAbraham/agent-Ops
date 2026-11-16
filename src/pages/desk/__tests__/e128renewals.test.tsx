import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

/** E128 / E129: renewals by a different agent, ready to renew, and the auto-passed renewal in the desk history. */

const h = vi.hoisted(() => ({ rpc: vi.fn() }));
const fromChain = { select: () => fromChain, eq: () => fromChain, in: () => fromChain, order: () => Promise.resolve({ data: [], error: null }) };
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: (...a: unknown[]) => h.rpc(...a), from: () => fromChain, storage: { from: vi.fn() } },
}));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u1' }, roles: ['agent_ops'] }) }));
vi.mock('@/hooks/useCrmVoiceCall', () => ({
  useCrmVoiceCall: () => ({ state: 'idle', callId: null, elapsed: 0, error: null, isEnding: false, start: vi.fn(), end: vi.fn() }),
  useHumanCallingPaused: () => ({ data: { paused: false, reason: null, paused_at: null } }),
  isTerminalCallState: () => false,
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { ReadyToRenewCard, RenewalAgentChangesCard, tenantAskedFirst, type ReadyToRenew } from '../renewals';
import { AUTO_PASSED_WORDS, DeskHistory, isAutoPassedRenewal } from '../deskHistory';

const wrap = (ui: ReactNode) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>);
const findEl = (sel: string) =>
  waitFor(() => {
    const el = document.querySelector(sel) as HTMLElement | null;
    expect(el).toBeTruthy();
    return el!;
  });
beforeEach(() => h.rpc.mockReset());

/* ───────────── 1. Renewals by a different agent ───────────── */

const PENDING = {
  rent_request_id: 'rr000000-0000-0000-0000-000000000001', ref: 'RR000000', status: 'pending',
  tenant: { name: 'Tina Tenant', phone: '0772000111' },
  prev_agent: { id: 'agent-prev', name: 'Paul Prev', phone: '0700111111' },
  new_agent: { id: 'agent-new', name: 'Nina New', phone: '0700222222' },
  created_at: '2026-11-15T08:00:00Z', decided_at: null, note: null,
};
const DECIDED = { ...PENDING, rent_request_id: 'rr000000-0000-0000-0000-000000000002', ref: 'RR000002', status: 'approved', decided_at: '2026-11-14T08:00:00Z' };

describe('Agent Ops · Renewals by a different agent', () => {
  it('tenant, previous and new agent with Call, the date; Approve keeps the new agent', async () => {
    h.rpc.mockImplementation((fn: string) =>
      Promise.resolve(fn === 'renewal_agent_changes_list' ? { data: [PENDING, DECIDED], error: null } : fn === 'renewal_agent_change_decide' ? { data: { ok: true }, error: null } : { data: null, error: null }),
    );
    wrap(<RenewalAgentChangesCard board={false} />);
    const row = await findEl('[data-agent-change="RR000000"]');
    const r = within(row);
    expect(r.getByRole('link', { name: 'Call tenant Tina Tenant' }).getAttribute('href')).toBe('tel:0772000111');
    expect(r.getByRole('link', { name: 'Call previous agent Paul Prev' }).getAttribute('href')).toBe('tel:0700111111');
    expect(r.getByRole('link', { name: 'Call new agent Nina New' }).getAttribute('href')).toBe('tel:0700222222');
    expect(row.textContent).toContain('15 Nov 2026');
    expect(document.querySelector('[data-agent-change="RR000002"]')?.textContent).toContain('Approved');
    expect(within(document.querySelector('[data-agent-change="RR000002"]') as HTMLElement).queryByRole('button', { name: 'Approve' })).toBeNull();

    fireEvent.click(r.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(h.rpc).toHaveBeenCalledWith('renewal_agent_change_decide', { p_request_id: PENDING.rent_request_id, p_approve: true, p_note: null }));
  });

  it('Send back to original agent: records it, then opens Transfer with the original agent picked', async () => {
    h.rpc.mockImplementation((fn: string) =>
      Promise.resolve(
        fn === 'renewal_agent_changes_list'
          ? { data: [PENDING], error: null }
          : fn === 'renewal_agent_change_decide'
            ? { data: { ok: true, next: 'transfer the tenant back' }, error: null }
            : fn === 'agent_ops_transfer_options'
              ? {
                  data: {
                    rows: [
                      { agent_id: 'agent-other', agent: 'Olga Other', phone: null, pct: 80, new_agent: false, open_requests: 1, plans: 3, km: 2, within_25km: true, transfers_7d: 0, grade: 'B' },
                      { agent_id: 'agent-prev', agent: 'Paul Prev', phone: '0700111111', pct: 70, new_agent: false, open_requests: 2, plans: 5, km: 4, within_25km: true, transfers_7d: 0, grade: 'B' },
                    ],
                  },
                  error: null,
                }
              : fn === 'ops_transfer_pipeline_request_agent'
                ? { data: { ok: true }, error: null }
                : { data: null, error: null },
      ),
    );
    wrap(<RenewalAgentChangesCard board={false} />);
    const row = await findEl('[data-agent-change="RR000000"]');
    fireEvent.click(within(row).getByRole('button', { name: 'Send back to original agent' }));
    await waitFor(() => expect(h.rpc).toHaveBeenCalledWith('renewal_agent_change_decide', { p_request_id: PENDING.rent_request_id, p_approve: false, p_note: null }));
    const picker = await screen.findByRole('dialog', { name: 'Pick an agent to transfer to' });
    await within(picker).findByText('Paul Prev');
    expect((within(picker).getByRole('textbox') as HTMLTextAreaElement).value).toBe('Renewal by a different agent: back to the original agent, Paul Prev');
    const confirm = await waitFor(() => {
      const b = within(picker).getAllByRole('button').find((x) => /Transfer|Confirm/i.test(x.textContent ?? '') && !(x as HTMLButtonElement).disabled);
      expect(b).toBeTruthy();
      return b!;
    });
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(h.rpc).toHaveBeenCalledWith('ops_transfer_pipeline_request_agent', {
        p_request_id: PENDING.rent_request_id,
        p_to_agent_id: 'agent-prev',
        p_reason: 'Renewal by a different agent: back to the original agent, Paul Prev',
      }),
    );
  });

  it('a decided one in plain words; hidden when there is nothing', async () => {
    h.rpc.mockImplementation((fn: string) =>
      Promise.resolve(fn === 'renewal_agent_changes_list' ? { data: [PENDING], error: null } : { data: null, error: { message: 'NOT_PENDING' } }),
    );
    const a = wrap(<RenewalAgentChangesCard board={false} />);
    const row = await findEl('[data-agent-change="RR000000"]');
    fireEvent.click(within(row).getByRole('button', { name: 'Approve' }));
    expect((await within(row).findByRole('alert')).textContent).toBe('This renewal has already been decided.');
    a.unmount();
    h.rpc.mockResolvedValue({ data: [], error: null });
    const b = wrap(<RenewalAgentChangesCard board={false} />);
    await waitFor(() => expect(h.rpc).toHaveBeenCalledWith('renewal_agent_changes_list'));
    await new Promise((r) => setTimeout(r, 20));
    expect(b.container.textContent).toBe('');
  });
});

/* ───────────── 2. Ready to renew ───────────── */

const RTR = (ref: string, name: string, asked: boolean): ReadyToRenew => ({
  last_request_id: `${ref}-id`, ref, tenant: { id: `t-${ref}`, name, phone: '0772000999' }, agent: { id: 'a1', name: 'Andy Agent', phone: '0700333333' },
  last_rent: 500000, last_days: 30, repaid: 600000, total: 600000, completed_on: '2026-11-10', tenant_asked: asked,
});

describe('Agent Ops and Tenant Ops · Ready to renew', () => {
  it('"Tenant asked" first, then the server’s order; tenant and agent with Call', async () => {
    h.rpc.mockResolvedValue({ data: [RTR('A1', 'Ann', false), RTR('B2', 'Ben', true), RTR('C3', 'Cara', false)], error: null });
    wrap(<ReadyToRenewCard board={false} />);
    await findEl('[data-ready-to-renew]');
    expect(h.rpc).toHaveBeenCalledWith('ready_to_renew', { p_all: true });
    expect(Array.from(document.querySelectorAll('[data-renew]')).map((e) => e.getAttribute('data-renew'))).toEqual(['B2', 'A1', 'C3']);
    const first = document.querySelector('[data-renew="B2"]') as HTMLElement;
    expect(first.textContent).toContain('Tenant asked');
    expect(within(first).getByRole('link', { name: 'Call tenant Ben' })).toBeTruthy();
    expect(within(first).getByRole('link', { name: 'Call agent Andy Agent' }).getAttribute('href')).toBe('tel:0700333333');
    expect(document.querySelector('[data-renew="A1"]')?.textContent).not.toContain('Tenant asked');
    expect(tenantAskedFirst([RTR('x', 'x', false), RTR('y', 'y', true)]).map((r) => r.ref)).toEqual(['y', 'x']);
  });

  it('empty', async () => {
    h.rpc.mockResolvedValue({ data: [], error: null });
    wrap(<ReadyToRenewCard board={false} />);
    expect(await screen.findByText('No tenant is waiting to renew.')).toBeTruthy();
  });

  it('sits on Agent Ops (both cards) and Tenant Ops (ready to renew)', () => {
    const page = readFileSync(resolve(__dirname, '../DeskPage.tsx'), 'utf8');
    expect(page).toContain("{desk.id === 'agent-ops' && <RenewalAgentChangesCard board={board} />}");
    expect(page).toContain("{(desk.id === 'agent-ops' || desk.id === 'tenant-ops') && <ReadyToRenewCard board={board} />}");
  });
});

/* ───────────── 3. The auto-passed renewal in the desk history ───────────── */

describe('Desk review · auto-passed renewal', () => {
  it('a Landlord Ops note starting "Auto-passed (E128 R1)" reads "Landlord Ops: auto-passed (unchanged renewal)"', async () => {
    expect(isAutoPassedRenewal('landlord_ops', 'Auto-passed (E128 R1): rent and landlord unchanged')).toBe(true);
    expect(isAutoPassedRenewal('tenant_ops', 'Auto-passed (E128 R1): …')).toBe(false);
    expect(isAutoPassedRenewal('landlord_ops', 'Landlord confirmed')).toBe(false);
    h.rpc.mockResolvedValue({
      data: {
        request: { id: 'r1', short_id: 'r1r1r1r1', status: 'coo_review' },
        desks: [
          { desk: 'landlord_ops', round: 0, decision: 'pass', system_said: 'pass', followed_system: true, reason: null, note: 'Auto-passed (E128 R1): unchanged renewal, same landlord and rent', score: null, by: 'System', staff_id: null, at: '2026-11-16T08:00:00Z', checks: [] },
          { desk: 'tenant_ops', round: 0, decision: 'pass', system_said: 'pass', followed_system: true, reason: null, note: 'Tenant confirmed', score: null, by: 'Tess', staff_id: 'E-1', at: '2026-11-15T08:00:00Z', checks: [] },
        ],
        calls: [],
        moves: [],
        concerns: [],
        other_actions: [],
      },
      error: null,
    });
    wrap(<DeskHistory requestId="r1" />);
    const auto = await findEl('[data-auto-passed]');
    expect(auto.textContent).toContain(AUTO_PASSED_WORDS);
    expect(document.body.textContent).not.toContain('Auto-passed (E128 R1)');
    expect(document.body.textContent).toContain('“Tenant confirmed”');
  });
});
