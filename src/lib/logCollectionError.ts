import { supabase } from '@/integrations/supabase/client';

/**
 * Record a collection failure where somebody can actually see it.
 *
 * The collection dialog already tells the three failure modes apart —
 * insufficient float, a stalled network where the payment was NOT recorded, and
 * a structured rejection carrying an `error_code`. Until this existed, all
 * three were `console.error`'d into a phone nobody will ever read, so a fault
 * that hit thirty agents on a Tuesday was invisible until someone noticed a
 * figure looking wrong days later.
 *
 * WHY THE EDGE FUNCTION IS TRIED FIRST, AND WHY THE RPC IS STILL HERE
 *
 * The obvious implementation — a Postgres RPC — fails in exactly the cases it
 * exists to record. It travels over the same connection that just broke, and
 * `log_agent_collection_error` returns NULL when `auth.uid()` is null, so a
 * failure caused by an EXPIRED SESSION was previously unloggable by definition.
 * That is why the log filled with server-written anomalies and almost nothing
 * from the engine.
 *
 * So the order is: edge function (writes with the service role, so a dead
 * session still logs) → RPC (works when the function is unreachable but the
 * database is not) → beacon on page-hide (survives the tab closing, which an
 * awaited fetch does not). Each hop records which path carried it, so a gap in
 * one is visible rather than silent.
 *
 * NEVER THROWS, NEVER BLOCKS THE CALLER. It runs on a path that is already
 * handling a failure; a logger that can fail would turn a recoverable error
 * into a crash, and one that blocks would add its own latency to an agent
 * already staring at a spinner.
 */
export type CollectionErrorPhase =
  | 'allocate'
  | 'allocate_stalled'
  | 'allocate_rejected'
  | 'offline_submit'
  | 'confirm'
  | 'sync';

export interface CollectionErrorInput {
  phase: CollectionErrorPhase;
  message: string;
  errorCode?: string | null;
  tenantId?: string | null;
  rentRequestId?: string | null;
  amount?: number | null;
  clientRef?: string | null;
  /** Anything that helps a reader reproduce it. Dropped server-side if oversized. */
  context?: Record<string, unknown> | null;
  /** `critical` is for "the agent may have handed over money that was not recorded". */
  severity?: 'critical' | 'error' | 'warning';
}

const FUNCTION_NAME = 'log-collection-error';

/** What the device could see at the moment it broke. None of this is in a stack trace. */
function deviceSnapshot() {
  let network = 'unknown';
  try {
    const conn = (navigator as unknown as {
      connection?: { effectiveType?: string; downlink?: number };
    }).connection;
    network = [
      navigator.onLine ? 'online' : 'offline',
      conn?.effectiveType,
      conn?.downlink != null ? `${conn.downlink}Mbps` : null,
    ].filter(Boolean).join(' · ');
  } catch { /* older browsers */ }

  return {
    user_agent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
    page_url: typeof location !== 'undefined' ? location.href : null,
    app_version: (import.meta as unknown as { env?: Record<string, string> })?.env?.VITE_APP_VERSION ?? null,
    network,
  };
}

function toPayload(input: CollectionErrorInput) {
  return {
    phase: input.phase,
    message: String(input.message ?? '').slice(0, 2000),
    error_code: input.errorCode ?? null,
    tenant_id: input.tenantId ?? null,
    rent_request_id: input.rentRequestId ?? null,
    amount: input.amount ?? null,
    client_ref: input.clientRef ?? null,
    context: input.context ?? null,
    severity: input.severity ?? 'error',
    ...deviceSnapshot(),
  };
}

/** Last resort. A beacon has no headers, so the token rides in the body. */
function beacon(payload: Record<string, unknown>, accessToken: string | null): boolean {
  try {
    if (typeof navigator === 'undefined' || !navigator.sendBeacon) return false;
    const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/${FUNCTION_NAME}`;
    const blob = new Blob(
      [JSON.stringify({ ...payload, access_token: accessToken, reported_via: 'beacon' })],
      { type: 'application/json' },
    );
    return navigator.sendBeacon(url, blob);
  } catch {
    return false;
  }
}

async function deliver(input: CollectionErrorInput): Promise<void> {
  const payload = toPayload(input);

  // 1. Edge function. Survives an expired session, because it writes as the
  //    service role rather than as the caller.
  try {
    const { error } = await supabase.functions.invoke(FUNCTION_NAME, {
      body: { ...payload, reported_via: 'edge' },
    });
    if (!error) return;
  } catch { /* fall through */ }

  // 2. The RPC. Reaches the database directly when the function is unreachable.
  try {
    const { error } = await (supabase as never as {
      rpc: (fn: string, args: Record<string, unknown>) => Promise<{ error: Error | null }>;
    }).rpc('log_agent_collection_error', {
      p_phase: payload.phase,
      p_message: payload.message,
      p_error_code: payload.error_code,
      p_tenant_id: payload.tenant_id,
      p_rent_request_id: payload.rent_request_id,
      p_amount: payload.amount,
      p_client_ref: payload.client_ref,
      p_context: payload.context,
      p_severity: payload.severity,
      p_user_agent: payload.user_agent,
      p_app_version: payload.app_version,
      p_page_url: payload.page_url,
      p_network: payload.network,
      p_reported_via: 'rpc',
    });
    if (!error) return;
  } catch { /* fall through */ }

  // 3. Beacon. The page may be dying; this is the only thing that outlives it.
  let token: string | null = null;
  try {
    const { data } = await supabase.auth.getSession();
    token = data.session?.access_token ?? null;
  } catch { /* unauthenticated report is still worth more than none */ }
  beacon(payload, token);
}

export function logCollectionError(input: CollectionErrorInput): void {
  try {
    void deliver(input).catch(() => {
      /* A logger that reports its own failure is a loop. */
    });
  } catch {
    /* Never let telemetry break a collection. */
  }
}

export default logCollectionError;
