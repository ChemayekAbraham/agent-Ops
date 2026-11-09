import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  status: { data: { status: 'approved' } as unknown, error: null as null | { message: string } },
  collections: { data: [] as unknown[], error: null as null | { message: string } },
  rpcCalls: 0,
  fromCalls: [] as Array<{ table: string; eq: [string, string]; limit: number }>,
  hang: false,
}));

vi.mock('@/lib/authenticatedRequests', () => ({
  withUserSession: (load: () => PromiseLike<unknown>) => load(),
}));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rpc: (name: string) => {
      db.rpcCalls++;
      if (name !== 'my_proxy_agent_status') throw new Error(`unexpected rpc ${name}`);
      return db.hang ? new Promise(() => {}) : Promise.resolve(db.status);
    },
    from: (table: string) => ({
      select: () => ({
        eq: (col: string, val: string) => ({
          limit: (n: number) => {
            db.fromCalls.push({ table, eq: [col, val], limit: n });
            return Promise.resolve(db.collections);
          },
        }),
      }),
    }),
  },
}));

import {
  PROXY_LANDING_CACHE_TTL_MS, checkProxyLanding, isPersonaLanding, readCachedProxyLanding, resolveProxyLanding,
} from './proxyLanding';

beforeEach(() => {
  db.status = { data: { status: 'approved' }, error: null };
  db.collections = { data: [], error: null };
  db.rpcCalls = 0;
  db.fromCalls = [];
  db.hang = false;
  localStorage.clear();
});
afterEach(() => { vi.useRealTimers(); });

describe('checkProxyLanding', () => {
  it('approved proxy agent with no collections → proxy dashboard', async () => {
    await expect(checkProxyLanding('u1')).resolves.toBe(true);
    expect(db.fromCalls).toEqual([{ table: 'agent_collections', eq: ['agent_id', 'u1'], limit: 1 }]);
  });

  it('approved proxy agent who has collected → normal landing', async () => {
    db.collections = { data: [{ id: 'c1' }], error: null };
    await expect(checkProxyLanding('u1')).resolves.toBe(false);
  });

  it.each(['pending', 'rejected', 'suspended', 'none'])('proxy status %s → normal landing, collections not read', async (s) => {
    db.status = { data: { status: s }, error: null };
    await expect(checkProxyLanding('u1')).resolves.toBe(false);
    expect(db.fromCalls).toEqual([]);
  });

  it('a failed lookup rejects instead of answering', async () => {
    db.status = { data: null, error: { message: 'Sign in again to continue.' } };
    await expect(checkProxyLanding('u1')).rejects.toThrow('Sign in again');
    db.status = { data: { status: 'approved' }, error: null };
    db.collections = { data: [], error: { message: 'permission denied' } };
    await expect(checkProxyLanding('u1')).rejects.toThrow('permission denied');
  });
});

describe('resolveProxyLanding', () => {
  it('caches the answer, so the next landing needs no lookup', async () => {
    await expect(resolveProxyLanding('u1')).resolves.toBe(true);
    expect(readCachedProxyLanding('u1')).toBe(true);
    db.status = { data: { status: 'none' }, error: null }; // would now say no
    await expect(resolveProxyLanding('u1')).resolves.toBe(true);
    expect(db.rpcCalls).toBe(1);
  });

  it('caches per user', async () => {
    await resolveProxyLanding('u1');
    expect(readCachedProxyLanding('u2')).toBeNull();
  });

  it('an expired cached answer is looked up again', async () => {
    await resolveProxyLanding('u1');
    const later = Date.now() + PROXY_LANDING_CACHE_TTL_MS + 1;
    expect(readCachedProxyLanding('u1', later)).toBeNull();
  });

  it('a lookup error lands normally and is not cached', async () => {
    db.status = { data: null, error: { message: 'boom' } };
    await expect(resolveProxyLanding('u1')).resolves.toBe(false);
    expect(readCachedProxyLanding('u1')).toBeNull();
  });

  it('a slow lookup lands normally after the timeout', async () => {
    vi.useFakeTimers();
    db.hang = true;
    const answer = resolveProxyLanding('u1', { timeoutMs: 1500 });
    await vi.advanceTimersByTimeAsync(1500);
    await expect(answer).resolves.toBe(false);
    expect(readCachedProxyLanding('u1')).toBeNull();
  });

  it('ignores a malformed cached value', async () => {
    localStorage.setItem('welile_proxy_landing_u1', '{"v":"yes"}');
    expect(readCachedProxyLanding('u1')).toBeNull();
    localStorage.setItem('welile_proxy_landing_u1', 'not json');
    expect(readCachedProxyLanding('u1')).toBeNull();
  });
});

describe('isPersonaLanding', () => {
  it('replaces persona landings and an unknown role, never staff dashboards', () => {
    for (const r of ['tenant', 'agent', 'supporter', 'landlord', null, undefined] as const) {
      expect(isPersonaLanding(r)).toBe(true);
    }
    for (const r of ['employee', 'cfo', 'operations', 'manager', 'partner_ops', 'super_admin'] as const) {
      expect(isPersonaLanding(r as never)).toBe(false);
    }
  });
});
