import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const ID_IN_CHUNK = 150;
const PORTFOLIO_COUNT = 151;

const fromMock = vi.fn();
const getSession = vi.fn();

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    auth: { getSession: (...args: unknown[]) => getSession(...args) },
    from: (table: string) => fromMock(table),
  },
}));

import { PortfolioTopUpsCard } from './PortfolioTopUpsCard';

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

type Call = { method: string; args: unknown[] };

const idLists: { table: string; ids: string[] }[] = [];

function chain(table: string) {
  const calls: Call[] = [];
  const api: Record<string, unknown> = {};
  const record = (method: string) => (...args: unknown[]) => {
    calls.push({ method, args });
    if (method === 'in' && args[0] === 'id' && Array.isArray(args[1])) {
      idLists.push({ table, ids: args[1] as string[] });
    }
    return api;
  };
  for (const method of ['select', 'eq', 'in', 'order', 'range']) api[method] = record(method);
  api.then = (resolve: (value: unknown) => void, reject: (reason: unknown) => void) => {
    Promise.resolve(answer(table, calls)).then(resolve, reject);
  };
  return api;
}

function answer(table: string, calls: Call[]) {
  if (table === 'pending_wallet_operations') {
    const range = calls.find((c) => c.method === 'range');
    const start = Number(range?.args[0] ?? 0);
    return { data: start > 0 ? [] : ops, error: null };
  }
  const listed = calls.find((c) => c.method === 'in' && c.args[0] === 'id');
  const ids = (listed?.args[1] as string[]) ?? [];
  if (table === 'investor_portfolios') {
    return {
      data: ids.map((id) => ({
        id,
        account_name: `Acct ${id}`,
        portfolio_code: `WIP-${id.slice(-4)}`,
        investor_id: id,
        investment_amount: 500000,
      })),
      error: null,
    };
  }
  if (table === 'profiles') {
    return { data: ids.map((id) => ({ id, full_name: `Partner ${id.slice(-4)}` })), error: null };
  }
  return { data: [], error: null };
}

const ops = [
  ...Array.from({ length: PORTFOLIO_COUNT }, (_, i) => {
    const id = uuid(i + 1);
    return {
      id: uuid(1000 + i),
      source_id: id,
      user_id: id,
      amount: 10000,
      status: 'pending',
      created_at: '2026-11-12T05:30:00Z',
      description: 'top up',
      metadata: {},
    };
  }),
  {
    id: uuid(2000),
    source_id: uuid(1),
    user_id: uuid(1),
    amount: 10000,
    status: 'pending',
    created_at: '2026-11-12T05:31:00Z',
    description: 'duplicate portfolio',
    metadata: {},
  },
  {
    id: uuid(2001),
    source_id: 'not-a-uuid',
    user_id: uuid(1),
    amount: 10000,
    status: 'pending',
    created_at: '2026-11-12T05:32:00Z',
    description: 'label',
    metadata: {},
  },
];

describe('PortfolioTopUpsCard portfolio label lookup', () => {
  beforeEach(() => {
    idLists.length = 0;
    fromMock.mockReset();
    fromMock.mockImplementation((table: string) => chain(table));
    getSession.mockReset();
    getSession.mockResolvedValue({
      data: {
        session: {
          user: { id: uuid(9) },
          access_token: 'token',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        },
      },
      error: null,
    });
  });

  it('loads portfolio and profile labels in chunks of at most 150 ids', async () => {
    render(<PortfolioTopUpsCard />);
    expect(await screen.findByText(String(ops.length))).toBeInTheDocument();

    const portfolioCalls = idLists.filter((c) => c.table === 'investor_portfolios');
    const profileCalls = idLists.filter((c) => c.table === 'profiles');
    expect(portfolioCalls.map((c) => c.ids.length)).toEqual([ID_IN_CHUNK, PORTFOLIO_COUNT - ID_IN_CHUNK]);
    expect(profileCalls.map((c) => c.ids.length)).toEqual([ID_IN_CHUNK, PORTFOLIO_COUNT - ID_IN_CHUNK]);
    for (const call of [...portfolioCalls, ...profileCalls]) {
      expect(call.ids.length).toBeLessThanOrEqual(ID_IN_CHUNK);
      expect(call.ids).not.toContain('not-a-uuid');
    }
    expect(new Set(portfolioCalls.flatMap((c) => c.ids)).size).toBe(PORTFOLIO_COUNT);

    fireEvent.click(screen.getByRole('button', { name: /Top-Ups/i }));
    const lastId = uuid(PORTFOLIO_COUNT);
    expect(await screen.findByText(`Acct ${lastId}`)).toBeInTheDocument();
    expect(screen.getByText(`Partner ${lastId.slice(-4)}`)).toBeInTheDocument();
  });
});
