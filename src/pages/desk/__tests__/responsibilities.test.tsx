import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const auth = vi.hoisted(() => ({ user: { id: 'u1' } as { id: string } | null, roles: [] as string[] }));

vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: vi.fn(), from: vi.fn(), storage: { from: vi.fn() } } }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => auth }));

import { supabase } from '@/integrations/supabase/client';
import { DeskRules, ResponsibilitiesBlock } from '../DeskRules';
import { firstRulesVisit, isCooOrCeo, rulesSeenKey, stepsFromText, type Responsibilities } from '../ontology/ontologyApi';
import { ResponsibilitiesEditor, responsibilitiesArgs } from '../ontology/ResponsibilitiesEditor';
import { AccountabilityFold, AccountabilityTable } from '../accountability/AccountabilityFold';
import { EMPTY_ACCOUNTABILITY, isDenied, rateText, rateTone, unfitShare, type AccountabilityRow } from '../accountability/accountabilityApi';

/** The supabase mock's rpc, typed loosely: vi.mocked on the full client type is too deep for tsc. */
const rpcMock = supabase.rpc as unknown as ReturnType<typeof vi.fn>;

function withClient(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

/** jsdom here has no localStorage; an in-memory one stands in. */
function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => (m.has(k) ? (m.get(k) as string) : null),
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  };
}

beforeEach(() => {
  rpcMock.mockReset();
  auth.user = { id: 'u1' };
  auth.roles = [];
  Object.defineProperty(window, 'localStorage', { value: memoryStorage(), configurable: true, writable: true });
});
afterEach(() => cleanup());

/* ───────────── fixtures ───────────── */

const RESP: Responsibilities = {
  title: 'Agent Ops',
  role_line: 'You check every request an agent sends before it moves on.',
  steps: ['Call the agent', 'Check the photos', 'Pass or send back'],
  must_not: 'Pass a request with missing landlord details.',
  accountability: 'Every pass carries your staff ID; a later unfit finding counts against it.',
  version: 3,
  updated_at: '2026-11-06T09:00:00Z',
};

const RULES_VIEW = { desk: 'agent-ops', board: 'Agent Ops', version: 'v0.9', rules: [], changed_7d: [], responsibilities: RESP };

const person = (name: string, passed: number, flagged: number, extra: Partial<AccountabilityRow> = {}): AccountabilityRow => ({
  stage: 'agent_ops',
  person_id: name,
  name,
  staff_ref: `ST-${name}`,
  passed,
  flagged,
  rate: null,
  items: [],
  ...extra,
});

/* ───────────── responsibilities ───────────── */

describe('responsibilities', () => {
  it('render with numbered steps, the not-allowed line and the accountability box', () => {
    const { container } = render(<ResponsibilitiesBlock r={RESP} />);
    expect(screen.getByText('Your responsibilities: Agent Ops')).not.toBeNull();
    const ol = container.querySelector('ol');
    expect(ol).not.toBeNull();
    expect(ol?.style.listStyleType).toBe('decimal');
    const steps = within(ol as HTMLElement).getAllByRole('listitem').map((li) => li.textContent);
    expect(steps).toEqual(['Call the agent', 'Check the photos', 'Pass or send back']);
    expect(screen.getByText('Not allowed:')).not.toBeNull();
    expect(container.querySelector('[data-accountability="true"]')?.textContent).toBe(RESP.accountability);
  });

  it('leaves out the not-allowed line when there is none', () => {
    render(<ResponsibilitiesBlock r={{ ...RESP, must_not: null }} />);
    expect(screen.queryByText('Not allowed:')).toBeNull();
  });

  it('opens "Rules for this desk" the first time, and only the first time', async () => {
    rpcMock.mockResolvedValue({ data: RULES_VIEW, error: null });
    expect(firstRulesVisit('u1', 'agent-ops')).toBe(true);

    const first = withClient(<DeskRules deskId="agent-ops" board={false} />);
    expect(await screen.findByText('Your responsibilities: Agent Ops')).not.toBeNull();
    expect(window.localStorage.getItem(rulesSeenKey('u1', 'agent-ops'))).not.toBeNull();
    first.unmount();

    withClient(<DeskRules deskId="agent-ops" board={false} />);
    expect((await screen.findByRole('button', { name: /Rules for this desk/ })).getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Your responsibilities: Agent Ops')).toBeNull();
    // Another desk is still a first visit.
    expect(firstRulesVisit('u1', 'tenant-ops')).toBe(true);
  });

  it('steps come one per line, without typed numbers', () => {
    expect(stepsFromText('1. Call the agent\n\n2) Check the photos\n  Pass  ')).toEqual(['Call the agent', 'Check the photos', 'Pass']);
  });
});

/* ───────────── accountability ───────────── */

describe('accountability rate', () => {
  it('turns red at 10%', () => {
    expect(rateTone(unfitShare(person('a', 10, 1)))).toBe('bad');
    expect(rateTone(unfitShare(person('b', 30, 3)))).toBe('bad');
    expect(rateTone(unfitShare(person('c', 1000, 99)))).toBe('plain');
    expect(rateTone(unfitShare(person('d', 0, 0)))).toBe('idle');
    expect(rateText(unfitShare(person('a', 10, 1)))).toBe('10%');
  });

  it('works from the counts, so the scale of rate never matters', () => {
    expect(unfitShare(person('a', 20, 1, { rate: 5 }))).toBeCloseTo(0.05);
    expect(unfitShare({ passed: null, flagged: null, rate: 12 })).toBeCloseTo(0.12);
    expect(unfitShare({ passed: null, flagged: null, rate: 0.12 })).toBeCloseTo(0.12);
  });

  it('paints the rate cell', () => {
    render(<AccountabilityTable rows={[person('Amina', 10, 1), person('Brian', 100, 9)]} />);
    expect(screen.getByText('10%').getAttribute('data-tone')).toBe('bad');
    expect(screen.getByText('9%').getAttribute('data-tone')).toBe('plain');
  });

  it('expands a row to the requests, their reason and the desk that found them', () => {
    render(
      <AccountabilityTable
        rows={[
          person('Amina', 10, 1, {
            items: [{ req: 'ab12cd34', id: 'ab12cd34-0000', label: 'Landlord phone wrong', found_at: '2026-11-05T08:00:00Z', found_on: 'landlord_ops' }],
          }),
        ]}
      />,
    );
    expect(screen.queryByText(/Landlord phone wrong/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Amina' }));
    expect(screen.getByText(/Landlord phone wrong/)).not.toBeNull();
    expect(screen.getByText(/found by Landlord Ops/)).not.toBeNull();
  });

  it('is a table from md up and cards on phones, from the same columns', () => {
    const rows = [person('Amina', 10, 1), person('Brian', 100, 9)];
    const t = render(<AccountabilityTable rows={rows} forceLayout="table" />);
    const table = t.container.querySelector('[data-layout="table"]');
    expect(table).not.toBeNull();
    expect([...(table as HTMLElement).querySelectorAll('th')].map((th) => th.textContent)).toEqual([
      'Name',
      'Staff ID',
      'Passed',
      'Later found unfit',
      'Rate',
    ]);
    t.unmount();

    const c = render(<AccountabilityTable rows={rows} forceLayout="cards" />);
    expect(c.container.querySelector('[data-layout="cards"]')).not.toBeNull();
    expect(c.container.querySelectorAll('[data-layout="cards"] > li')).toHaveLength(2);
    expect(screen.getByText('10%').getAttribute('data-tone')).toBe('bad');
  });

  it('has the agreed empty state', () => {
    render(<AccountabilityTable rows={[]} />);
    expect(screen.getByText(EMPTY_ACCOUNTABILITY)).not.toBeNull();
    expect(EMPTY_ACCOUNTABILITY).toBe('No passed request has been found unfit yet.');
  });

  it('hides from a caller the server refuses, and the command centre from anyone but COO/CEO', async () => {
    expect(isDenied({ code: '42501', message: 'x' })).toBe(true);
    expect(isDenied({ message: 'permission denied for function desk_accountability' })).toBe(true);
    expect(isDenied({ code: 'PGRST202', message: 'Could not find the function' })).toBe(false);

    rpcMock.mockResolvedValue({ data: null, error: { code: '42501', message: 'not a desk lead' } });
    const { container } = withClient(<AccountabilityFold deskId="agent-ops" board={false} />);
    await waitFor(() => expect(rpcMock).toHaveBeenCalled());
    expect(container.textContent).toBe('');

    cleanup();
    rpcMock.mockReset();
    const cc = withClient(<AccountabilityFold deskId={null} board={false} />);
    expect(cc.container.textContent).toBe('');
    expect(rpcMock).not.toHaveBeenCalled();

    cleanup();
    auth.roles = ['coo'];
    expect(isCooOrCeo(auth.roles)).toBe(true);
    rpcMock.mockResolvedValue({ data: { rows: [] }, error: null });
    withClient(<AccountabilityFold deskId={null} board={false} />);
    expect(await screen.findByRole('button', { name: /Accountability — every desk/ })).not.toBeNull();
    expect(rpcMock).toHaveBeenCalledWith('desk_accountability', { p_desk: null, p_days: 30 });
  });
});

/* ───────────── edit ───────────── */

describe('edit responsibilities', () => {
  it('builds the save args from the form', () => {
    expect(
      responsibilitiesArgs('tenant-ops', { title: ' Tenant Ops ', roleLine: 'Role', steps: 'One\nTwo', mustNot: '  ', accountability: 'Yours' }),
    ).toEqual({ p_desk: 'tenant-ops', p_title: 'Tenant Ops', p_role_line: 'Role', p_steps: ['One', 'Two'], p_must_not: null, p_accountability: 'Yours' });
  });

  it('loads through ontology_rules_for_desk and saves the right args', async () => {
    auth.roles = ['ceo'];
    rpcMock.mockImplementation(async (fn: string) =>
      fn === 'ontology_rules_for_desk' ? { data: RULES_VIEW, error: null } : { data: { version: 4 }, error: null },
    );
    withClient(<ResponsibilitiesEditor />);

    const title = (await screen.findByLabelText('Title')) as HTMLInputElement;
    await waitFor(() => expect(title.value).toBe('Agent Ops'));
    expect(rpcMock).toHaveBeenCalledWith('ontology_rules_for_desk', { p_desk: 'service-centre' });

    fireEvent.change(title, { target: { value: 'Service Centre' } });
    fireEvent.change(screen.getByLabelText('Steps'), { target: { value: 'Meet the agent\nCheck the ID' } });
    fireEvent.change(screen.getByLabelText('Not allowed'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save responsibilities' }));

    await screen.findByText(/Saved as version 4/);
    expect(rpcMock).toHaveBeenCalledWith('desk_responsibilities_set', {
      p_desk: 'service-centre',
      p_title: 'Service Centre',
      p_role_line: RESP.role_line,
      p_steps: ['Meet the agent', 'Check the ID'],
      p_must_not: null,
      p_accountability: RESP.accountability,
    });
  });
});
