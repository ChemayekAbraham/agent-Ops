import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

/** E126: "Plan set-up issues" on the Command Centre with push to the CFO; read-only for the CFO; the CFO bell shows the pushes. */

const h = vi.hoisted(() => ({ rpc: vi.fn(), notices: [] as Record<string, unknown>[], updates: [] as unknown[] }));
vi.mock('@/integrations/supabase/client', () => {
  const builder = () => {
    const b: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'is', 'order', 'limit']) b[m] = vi.fn(() => b);
    b.update = vi.fn((row: unknown) => {
      h.updates.push(row);
      return b;
    });
    b.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: h.notices, error: null }).then(ok);
    return b;
  };
  return { supabase: { rpc: (...a: unknown[]) => h.rpc(...a), from: () => builder(), storage: { from: vi.fn() } } };
});
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u1' }, roles: ['coo'] }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/hooks/useCfoApprovalNotifications', () => ({ useCfoApprovalNotifications: () => ({ notifications: [], failed: [], total: 0, isLoading: false }) }));
vi.mock('@/components/budget/useBudgetDepartmentNotifications', () => ({
  useBudgetDepartmentNotifications: () => ({ items: [], unread: 0, markRead: vi.fn(), markAll: vi.fn() }),
}));

import { PlanIssuesCard } from '../coo/PlanIssues';
import { CFOApprovalNotificationsBell } from '@/components/cfo/CFOApprovalNotificationsBell';

const NO_TERMS = {
  rent_request_id: 'aaaa1111-0000-0000-0000-000000000001', ref: 'AAAA1111', kind: 'repaying_no_terms',
  problem: 'Repaying, but has no daily amount or total - invisible to collections and arrears', status: 'repaying',
  tenant: { name: 'Tina T', phone: '0772000111' }, agent: { name: 'Andy A', phone: '0700123456' },
  rent: 500000, daily: null, total: null, repaid: 0, gap: 0, funded_at: '2026-10-02T08:00:00Z', pushed: null,
};
const UNDERPAID = {
  rent_request_id: 'bbbb2222-0000-0000-0000-000000000002', ref: 'BBBB2222', kind: 'completed_underpaid',
  problem: 'Marked completed but repaid less than the total, with no waiver on record', status: 'completed',
  tenant: { name: 'Uma U', phone: '0772000222' }, agent: { name: 'Ben B', phone: null },
  rent: 300000, daily: 12000, total: 360000, repaid: 160000, gap: 200000, funded_at: '2026-08-15T08:00:00Z',
  pushed: { at: '2026-11-16T07:30:00Z', by: 'ST-0001', note: 'Confirm the waiver' },
};

const wrap = (ui: ReactNode, path = '/') =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
const findEl = (sel: string) =>
  waitFor(() => {
    const el = document.querySelector(sel) as HTMLElement | null;
    expect(el).toBeTruthy();
    return el!;
  });

beforeEach(() => {
  h.rpc.mockReset();
  h.notices = [];
  h.updates = [];
});

describe('Plan set-up issues', () => {
  it('two groups, the total gap, Call for tenant and agent, the funded date; a pushed row says so and offers "Push again"', async () => {
    h.rpc.mockResolvedValue({ data: { rule: 'PLAN-INTEGRITY (E126): …', items: [NO_TERMS, UNDERPAID] }, error: null });
    wrap(<PlanIssuesCard board={false} canPush />);
    const noTerms = await findEl('[data-issue-group="repaying_no_terms"]');
    expect(h.rpc).toHaveBeenCalledWith('plan_integrity_issues');
    expect(noTerms.textContent).toContain('Repaying with no terms (1)');
    expect(noTerms.querySelector('[data-plan-problem]')?.textContent).toBe(NO_TERMS.problem);
    const under = document.querySelector('[data-issue-group="completed_underpaid"]') as HTMLElement;
    expect(under.textContent).toContain('Completed but underpaid (1)');
    expect(under.querySelector('[data-plan-money]')?.textContent).toBe('Repaid UGX 160,000 of UGX 360,000 · gap UGX 200,000');
    expect(document.querySelector('[data-total-gap]')?.textContent).toBe('Total gap UGX 200,000');

    const row = document.querySelector('[data-plan-issue="AAAA1111"]') as HTMLElement;
    expect(within(row).getByRole('link', { name: 'Call tenant Tina T' }).getAttribute('href')).toBe('tel:0772000111');
    expect(within(row).getByRole('link', { name: 'Call agent Andy A' }).getAttribute('href')).toBe('tel:0700123456');
    expect(row.textContent).toContain('Funded 2 Oct 2026');
    expect(within(row).getByRole('button', { name: 'Push to CFO' })).toBeTruthy();

    const pushed = document.querySelector('[data-plan-issue="BBBB2222"]') as HTMLElement;
    expect(pushed.querySelector('[data-pushed]')?.textContent).toContain('Pushed 16 Nov');
    expect(pushed.querySelector('[data-pushed]')?.textContent).toContain('by ST-0001');
    expect(within(pushed).getByRole('button', { name: 'Push again' })).toBeTruthy();
  });

  it('Push to CFO sends the request and the note; the row then shows "Pushed"', async () => {
    let pushedYet = false;
    h.rpc.mockImplementation((fn: string) => {
      if (fn === 'plan_integrity_push') {
        pushedYet = true;
        return Promise.resolve({ data: { ok: true, kind: 'repaying_no_terms', cfo_notified: 2 }, error: null });
      }
      const item = pushedYet ? { ...NO_TERMS, pushed: { at: '2026-11-16T09:15:00Z', by: 'ST-0042', note: 'Set the terms' } } : NO_TERMS;
      return Promise.resolve({ data: { items: [item] }, error: null });
    });
    wrap(<PlanIssuesCard board={false} canPush />);
    fireEvent.click(await screen.findByRole('button', { name: 'Push to CFO' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Note for the CFO about AAAA1111' }), { target: { value: 'Set the terms' } });
    fireEvent.click(screen.getByRole('button', { name: 'Push to CFO · AAAA1111' }));
    await waitFor(() => expect(h.rpc).toHaveBeenCalledWith('plan_integrity_push', { p_request_id: NO_TERMS.rent_request_id, p_note: 'Set the terms' }));
    const line = await findEl('[data-plan-issue="AAAA1111"] [data-pushed]');
    expect(line.textContent).toContain('Pushed 16 Nov');
    expect(line.textContent).toContain('by ST-0042');
    expect(await screen.findByRole('button', { name: 'Push again' })).toBeTruthy();
  });

  it('refusals in plain words (COO_ONLY, NO_ISSUE)', async () => {
    h.rpc.mockImplementation((fn: string) =>
      Promise.resolve(fn === 'plan_integrity_push' ? { data: null, error: { code: '42501', message: 'COO_ONLY: only the COO / CEO can push plan issues' } } : { data: { items: [NO_TERMS] }, error: null }),
    );
    wrap(<PlanIssuesCard board={false} canPush />);
    fireEvent.click(await screen.findByRole('button', { name: 'Push to CFO' }));
    fireEvent.click(screen.getByRole('button', { name: 'Push to CFO · AAAA1111' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Only the COO or the CEO can push plan issues to the CFO.');
    h.rpc.mockImplementation((fn: string) =>
      Promise.resolve(fn === 'plan_integrity_push' ? { data: null, error: { message: 'NO_ISSUE: this plan no longer has a set-up issue' } } : { data: { items: [NO_TERMS] }, error: null }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Push to CFO · AAAA1111' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('This plan no longer has a set-up issue, so there is nothing to push.'));
  });

  it('empty: "No plan set-up issues." and a zero total', async () => {
    h.rpc.mockResolvedValue({ data: { items: [] }, error: null });
    wrap(<PlanIssuesCard board={false} canPush />);
    expect(await screen.findByText('No plan set-up issues.')).toBeTruthy();
    expect(document.querySelector('[data-total-gap]')?.textContent).toBe('Total gap UGX 0');
  });

  it('read-only for the CFO: the same rows, no push', async () => {
    h.rpc.mockResolvedValue({ data: { items: [NO_TERMS, UNDERPAID] }, error: null });
    wrap(<PlanIssuesCard board={false} canPush={false} />);
    await findEl('[data-plan-issue="AAAA1111"]');
    expect(screen.queryByRole('button', { name: /Push/ })).toBeNull();
    expect(document.querySelector('[data-plan-issue="BBBB2222"] [data-pushed]')).toBeTruthy();
  });

  it('on the Command Centre with the push, and on the CFO home read-only', () => {
    expect(readFileSync(resolve(__dirname, '../CommandCentre.tsx'), 'utf8')).toContain('<PlanIssuesCard board={false} canPush />');
    expect(readFileSync(resolve(__dirname, '../../cfo/Dashboard.tsx'), 'utf8')).toContain('<CfoPlanIssues />');
  });
});

describe('the CFO bell', () => {
  it('shows the cfo_plan_review notices, unread in the badge; a tap marks it read and opens /cfo', async () => {
    h.notices = [
      { id: 'n1', title: 'COO: rent plan needs your decision (BBBB2222)', message: 'Plan BBBB2222 is marked completed but repaid UGX 160,000 of UGX 360,000.', is_read: false, created_at: new Date().toISOString(), link_path: '/cfo' },
    ];
    const Where = () => <span data-where>{useLocation().pathname}</span>;
    wrap(
      <Routes>
        <Route
          path="*"
          element={
            <>
              <CFOApprovalNotificationsBell onJump={() => {}} />
              <Where />
            </>
          }
        />
      </Routes>,
      '/somewhere',
    );
    const bell = await screen.findByRole('button', { name: '1 notifications awaiting your review' });
    fireEvent.click(bell);
    const item = await findEl('[data-cfo-plan-review="n1"]');
    expect(item.textContent).toContain('COO: rent plan needs your decision (BBBB2222)');
    fireEvent.click(item);
    await waitFor(() => expect(document.querySelector('[data-where]')?.textContent).toBe('/cfo'));
    expect(h.updates[0]).toEqual(expect.objectContaining({ is_read: true }));
  });
});
