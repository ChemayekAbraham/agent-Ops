import type { SupabaseClient } from '@supabase/supabase-js';
import { readHistory, readTwin, type HistoryDay, type Twin } from './twinModel';

/**
 * Where the twin is read from. Every call is a read-only RPC; the twin never
 * writes. Staff use their own session (the database checks the role and
 * redacts partner detail); a boardroom display uses the display code with the
 * public key only.
 */
export type TwinSource = {
  kind: 'staff' | 'board';
  /** Live rolling 24 hours (not saved). */
  now(signal: AbortSignal): Promise<Twin | null>;
  /** The saved run for one EAT day. */
  day(date: string, signal: AbortSignal): Promise<Twin | null>;
  /** One summary per day, for the day picker, the ribbon and the trend line. */
  history(days: number, signal: AbortSignal): Promise<HistoryDay[]>;
  /** The client that can subscribe to realtime changes (staff only). */
  realtime: SupabaseClient | null;
};

export class TwinError extends Error {
  code?: string;
  notAllowed: boolean;
  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
    this.notAllowed = /OPS_TWIN_NOT_ALLOWED/.test(message);
    if (this.notAllowed) this.message = NOT_ALLOWED_TEXT;
  }
}
export const NOT_ALLOWED_TEXT =
  'The twin is open to the COO, CEO, CFO, CTO, super admins, all-desk holders and the Command Centre desk. Your account is not one of them.';

type Rpc = (fn: string, args?: Record<string, unknown>) => { abortSignal(s: AbortSignal): PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }> };

async function call(rpc: Rpc, fn: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
  const { data, error } = await rpc(fn, args).abortSignal(signal);
  if (error) throw new TwinError(error.message || 'The twin could not be loaded.', error.code);
  return data;
}

/** Signed-in staff. The RPCs are not in the generated types, so they go through a cast. */
export function staffSource(client: SupabaseClient): TwinSource {
  const rpc = client.rpc.bind(client) as unknown as Rpc;
  return {
    kind: 'staff',
    now: async (s) => readTwin(await call(rpc, 'ops_twin_now', {}, s)),
    day: async (date, s) => readTwin(await call(rpc, 'ops_twin_day', { p_date: date }, s)),
    history: async (days, s) => readHistory(await call(rpc, 'ops_twin_history', { p_days: days }, s)),
    realtime: client,
  };
}

/** A boardroom display: the code is checked by the server on every call. */
export function boardSource(client: SupabaseClient, token: string): TwinSource {
  const raw = client.rpc.bind(client) as unknown as Rpc;
  // Once the server refuses this display code, stop asking: every timed reload would only repeat the refusal.
  let refused: TwinError | null = null;
  const guarded = async (fn: string, args: Record<string, unknown>, s: AbortSignal) => {
    if (refused) throw refused;
    try {
      return await call(raw, fn, args, s);
    } catch (e) {
      if (e instanceof TwinError && (e.code === '42501' || e.notAllowed)) refused = e;
      throw e;
    }
  };
  return {
    kind: 'board',
    now: async (s) => readTwin(await guarded('ops_twin_board_now', { p_token: token }, s)),
    day: async (date, s) => readTwin(await guarded('ops_twin_board_day', { p_token: token, p_date: date }, s)),
    history: async (days, s) => readHistory(await guarded('ops_twin_board_history', { p_token: token, p_days: days }, s)),
    realtime: null,
  };
}
