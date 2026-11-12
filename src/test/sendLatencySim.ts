/**
 * A fake Supabase client with modelled latencies, for timing the send paths under
 * vi.useFakeTimers(). Server times are the measured ones (last 24 h); the agent's
 * phone link is an assumption: every request pays a fixed round trip, and uploads
 * share one uplink, so running them side by side saves round trips, not bandwidth.
 */
import { vi } from 'vitest';

export const LATENCY = {
  /** Round trip from an agent's phone to Supabase, per request. Assumption. */
  rttMs: 300,
  /** Shared upload bandwidth (1 Mbit/s). Assumption. */
  uplinkBytesPerMs: 125,
  /** Measured: rent_requests insert ~0.8 s. */
  insertMs: 800,
  /** Measured: RPCs < 0.15 s. */
  rpcMs: 150,
  /** Table reads and small updates, like an RPC. */
  tableMs: 150,
  /** register-tenant edge function. Not in the measured list; assumption. */
  registerTenantMs: 1000,
  /** tenant-self-onboarding edge function, server side (uploads + insert). Assumption. */
  tenantOnboardingMs: 2500,
};

/** Measured sizes after the phone's optimiser. */
export const SIZES = { housePhoto: 48_000, lcLetter: 236_000, idPhoto: 236_000, tenantPhoto: 100_000 };

export const sizedFile = (bytes: number, name: string) => new File([new Uint8Array(bytes)], name, { type: 'image/jpeg' });

type Transfer = { left: number; done: () => void };

export function createLatencySim() {
  const transfers = new Set<Transfer>();
  const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  let ticking: ReturnType<typeof setInterval> | null = null;
  const TICK = 5;
  const pump = () => {
    if (!transfers.size) return;
    const share = (LATENCY.uplinkBytesPerMs * TICK) / transfers.size;
    for (const t of [...transfers]) {
      t.left -= share;
      if (t.left <= 0) { transfers.delete(t); t.done(); }
    }
  };
  const transfer = (bytes: number) => new Promise<void>((done) => {
    if (!ticking) ticking = setInterval(pump, TICK);
    transfers.add({ left: bytes, done });
  });

  /** Every call made, with its start time (fake clock). */
  const calls: { name: string; at: number }[] = [];
  const log = (name: string) => calls.push({ name, at: Date.now() });

  const rpcResults: Record<string, unknown> = {
    get_landlord_verification_status: [{ exists_flag: true }],
    find_lc1_by_phone: [{ id: 'lc1-1' }],
    verify_landlord_registered: true,
    check_phone_exists: false,
  };

  const builder = (table: string) => {
    let isInsert = false;
    const b: Record<string, unknown> = {};
    const run = async () => {
      await wait(LATENCY.rttMs + (isInsert ? LATENCY.insertMs : LATENCY.tableMs));
      if (table === 'rent_requests' && isInsert) return { data: { id: 'req-1' }, error: null };
      if (table === 'house_listings') return { data: { id: 'h1', status: 'available', tenant_id: null, reserved_at: null, is_hidden: false }, error: null };
      return { data: [{ id: 'x' }], error: null };
    };
    for (const m of ['select', 'eq', 'is', 'update', 'limit', 'order', 'in', 'neq']) b[m] = vi.fn(() => b);
    b.insert = vi.fn(() => { isInsert = true; log(`insert:${table}`); return b; });
    b.update = vi.fn(() => { log(`update:${table}`); return b; });
    b.single = () => run();
    b.maybeSingle = () => run();
    b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => run().then(res, rej);
    return b;
  };

  const supabase = {
    auth: {
      getSession: vi.fn(async () => ({ data: { session: { user: { id: 'agent-1' } } }, error: null })),
      refreshSession: vi.fn(async () => ({ error: null })),
    },
    from: vi.fn((table: string) => builder(table)),
    rpc: vi.fn(async (fn: string) => {
      log(`rpc:${fn}`);
      await wait(LATENCY.rttMs + LATENCY.rpcMs);
      return { data: fn in rpcResults ? rpcResults[fn] : { ok: true }, error: null };
    }),
    functions: {
      invoke: vi.fn(async (fn: string) => {
        log(`fn:${fn}`);
        if (fn === 'register-tenant') {
          await wait(LATENCY.rttMs + LATENCY.registerTenantMs);
          return { data: { user_id: 'tenant-1', existing: false }, error: null };
        }
        if (fn === 'tenant-self-onboarding') {
          await wait(LATENCY.rttMs + LATENCY.tenantOnboardingMs);
          return { data: { rent_request_id: 'req-1' }, error: null };
        }
        // Notices, SMS, the assistant: long on the server; never on the send path.
        await wait(LATENCY.rttMs + 5200);
        return { data: { ok: true }, error: null };
      }),
    },
    storage: {
      from: (bucket: string) => ({
        upload: vi.fn(async (path: string, file: File) => {
          log(`upload:${bucket}/${path}`);
          await wait(LATENCY.rttMs);
          await transfer(file.size);
          return { error: null };
        }),
        getPublicUrl: (p: string) => ({ data: { publicUrl: `https://cdn/${bucket}/${p}` } }),
        createSignedUrl: async () => ({ data: { signedUrl: 'https://signed' }, error: null }),
      }),
    },
  };

  /** Runs `job` on the fake clock and returns how long it took, in ms. */
  async function time<T>(job: () => Promise<T>): Promise<{ ms: number; value: T }> {
    const start = Date.now();
    let settled = false;
    let value!: T;
    let failure: unknown;
    const p = job().then((v) => { value = v; }, (e) => { failure = e; }).finally(() => { settled = true; });
    while (!settled) await vi.advanceTimersByTimeAsync(TICK);
    await p;
    if (failure) throw failure;
    if (ticking) { clearInterval(ticking); ticking = null; }
    return { ms: Date.now() - start, value };
  }

  return { supabase, calls, time };
}
