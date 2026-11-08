import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

const rpcMock = vi.fn();
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: (...a: unknown[]) => rpcMock(...a), from: vi.fn(), storage: { from: vi.fn() } },
}));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u1' }, roles: [] }) }));
// The other People tabs are heavy and not under test here.
vi.mock('@/hr/components/StaffDirectory', () => ({ default: () => <div>Directory</div> }));
vi.mock('@/hr/pay/PayrollEnrollment', () => ({ default: () => <div>Pay setup</div> }));
vi.mock('@/hr/contracts/Contracts', () => ({ default: () => <div>Contracts</div> }));
vi.mock('@/components/hr/HRBirthdayRegister', () => ({ default: () => <div>Birthdays</div> }));
vi.mock('@/hr/pages/HRPlaceholderPage', () => ({ default: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

import { DESKS } from '../deskConfig';
import { NOT_ASSIGNED, accessLanding, deskRouteId, desksByAccess, isAllDesksEntry, isNotAssigned, type MyAccess } from '../deskAccess';
import { readableError } from '../reviewApi';
import DeskAccessManager from '@/hr/components/DeskAccessManager';
import PeoplePage from '@/hr/pages/People';

const access = (over: Partial<MyAccess>): MyAccess => ({
  enforced: true, employee: true, all: false, desks: [], desk: null, sc_person: false, can_manage: false, ...over,
});
const byRole = DESKS.filter((d) => ['coo', 'agent-ops', 'tenant-ops'].includes(d.id));
const ids = (list: { id: string }[]) => list.map((d) => d.id);

describe('desk tabs by access', () => {
  it('not enforced, no answer, or all desks: the role-based tabs stay as they are', () => {
    expect(desksByAccess(byRole, DESKS, access({ enforced: false, desks: ['cfo'] }))).toBe(byRole);
    expect(desksByAccess(byRole, DESKS, null)).toBe(byRole);
    expect(desksByAccess(byRole, DESKS, access({ all: true }))).toBe(byRole);
  });

  it('enforced: exactly the desks HR gave, in the page’s own tab order', () => {
    const got = desksByAccess(byRole, DESKS, access({ desks: ['landlord_ops', 'agent_ops'] }));
    const order = ids(DESKS);
    expect(ids(got)).toEqual(['agent-ops', 'landlord-ops'].sort((a, b) => order.indexOf(a) - order.indexOf(b)));
  });

  it('a Service Centre person also gets the Service Centre; aliases resolve', () => {
    expect(ids(desksByAccess([], DESKS, access({ desks: [], sc_person: true })))).toEqual(['service-centre']);
    expect(ids(desksByAccess([], DESKS, access({ desks: ['funders'] })))).toEqual(['cfo']);
    expect(deskRouteId('Tenant_Ops')).toBe('tenant-ops');
  });

  it('enforced with nothing assigned: no desks', () => {
    expect(desksByAccess(byRole, DESKS, access({ desks: [] }))).toEqual([]);
  });

  it('redirects to HR’s landing desk when allowed, else the first allowed desk', () => {
    const allowed = desksByAccess([], DESKS, access({ desks: ['tenant_ops', 'agent_ops'] }));
    expect(accessLanding(allowed, access({ desk: 'tenant_ops' }))?.id).toBe('tenant-ops');
    expect(accessLanding(allowed, access({ desk: 'cfo' }))?.id).toBe(allowed[0].id);
    expect(accessLanding([], access({}))).toBeNull();
  });

  it('a 42501 "This desk is not assigned to you" shows that text', () => {
    const err = { code: '42501', message: 'This desk is not assigned to you' };
    expect(isNotAssigned(err)).toBe(true);
    expect(readableError(err)).toBe(NOT_ASSIGNED);
    // Other 42501s keep the staff-ID sentence.
    expect(readableError({ code: '42501', message: 'permission denied' })).toMatch(/staff ID/);
  });
});

const LIST = {
  enforced: false,
  desks: [
    { desk: 'all', label: 'All desks (COO, CEO)', members: [{ user_id: 'boss', name: 'Cora COO', staff_ref: 'EMP-1', active_employee: true, added_at: null, added_by: null }] },
    { desk: 'agent_ops', label: 'Agent Ops', members: [{ user_id: 'u-ann', name: 'Ann', staff_ref: 'EMP-7', active_employee: true, added_at: null, added_by: 'HR' }] },
  ],
};

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/hr/people?tab=desks']}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('HR → People → Desks', () => {
  beforeEach(() => {
    rpcMock.mockReset();
    rpcMock.mockImplementation((fn: string) => {
      if (fn === 'desk_access_list') return Promise.resolve({ data: LIST, error: null });
      if (fn === 'desk_access_candidates')
        return Promise.resolve({ data: [{ user_id: 'u-bo', name: 'Bo', staff_ref: 'EMP-9', phone: null, desks: [] }, { user_id: 'u-cy', name: 'Cy', staff_ref: 'EMP-10', phone: null, desks: ['coo'] }], error: null });
      return Promise.resolve({ data: null, error: null });
    });
  });

  it('the Desks tab shows only when can_manage is true', async () => {
    rpcMock.mockImplementation((fn: string) =>
      Promise.resolve(fn === 'desk_my_access' ? { data: access({ can_manage: false }), error: null } : { data: null, error: null }),
    );
    const first = wrap(<PeoplePage />);
    await waitFor(() => expect(rpcMock).toHaveBeenCalledWith('desk_my_access', {}));
    expect(screen.queryByRole('tab', { name: 'Desks' })).toBeNull();
    first.unmount();

    rpcMock.mockImplementation((fn: string) =>
      Promise.resolve(fn === 'desk_my_access' ? { data: access({ can_manage: true }), error: null } : fn === 'desk_access_list' ? { data: LIST, error: null } : { data: null, error: null }),
    );
    wrap(<PeoplePage />);
    expect(await screen.findByRole('tab', { name: 'Desks' })).toBeTruthy();
  });

  it('shows the amber "not enforced" banner and keeps the all-desks card read-only', async () => {
    wrap(<DeskAccessManager />);
    expect(await screen.findByText('Desk access is not enforced yet — the COO turns it on')).toBeTruthy();
    const all = document.querySelector('[data-desk="all"]') as HTMLElement;
    expect(all.getAttribute('data-readonly')).toBe('true');
    expect(within(all).queryByRole('button')).toBeNull();
    expect(within(all).getByText('Cora COO')).toBeTruthy();
  });

  it('× calls desk_access_remove with the desk and the person', async () => {
    wrap(<DeskAccessManager />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Ann from Agent Ops' }));
    await waitFor(() => expect(rpcMock).toHaveBeenCalledWith('desk_access_remove', { p_desk: 'agent_ops', p_user: 'u-ann' }));
  });

  it('Add people calls desk_access_add once per person picked', async () => {
    wrap(<DeskAccessManager />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add people to Agent Ops' }));
    await screen.findByText('Bo');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Bo' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Cy' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add 2 to Agent Ops' }));
    await waitFor(() => expect(rpcMock).toHaveBeenCalledWith('desk_access_add', { p_desk: 'agent_ops', p_user: 'u-bo' }));
    expect(rpcMock).toHaveBeenCalledWith('desk_access_add', { p_desk: 'agent_ops', p_user: 'u-cy' });
  });

  it('recognises the all-desks entry by id or label', () => {
    expect(isAllDesksEntry({ desk: 'all', label: null })).toBe(true);
    expect(isAllDesksEntry({ desk: 'x', label: 'All desks (COO, CEO)' })).toBe(true);
    expect(isAllDesksEntry({ desk: 'agent_ops', label: 'Agent Ops' })).toBe(false);
  });
});
