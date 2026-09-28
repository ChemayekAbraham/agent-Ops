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
 * WHY THIS IS CALLED FROM THE CLIENT AND NOT RAISED INSIDE THE RPC.
 * Postgres has no autonomous transactions: an exception handler inside the
 * allocator that INSERTs a log row has that row rolled back along with the
 * statement it was reporting on. The log would be empty exactly when it
 * mattered. The failure has to be recorded from outside the aborted
 * transaction.
 *
 * NEVER THROWS, NEVER AWAITS THE CALLER'S PATH. It runs on a path that is
 * already handling a failure; a logger that can fail would turn a recoverable
 * error into a crash, and one that blocks would add its own latency to an
 * agent already staring at a spinner. Fire and forget.
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

export function logCollectionError(input: CollectionErrorInput): void {
  try {
    const rpc = (supabase as never as {
      rpc: (fn: string, args: Record<string, unknown>) => Promise<unknown>;
    }).rpc;

    void Promise.resolve(
      rpc('log_agent_collection_error', {
        p_phase: input.phase,
        p_message: String(input.message ?? '').slice(0, 2000),
        p_error_code: input.errorCode ?? null,
        p_tenant_id: input.tenantId ?? null,
        p_rent_request_id: input.rentRequestId ?? null,
        p_amount: input.amount ?? null,
        p_client_ref: input.clientRef ?? null,
        p_context: input.context ?? null,
        p_severity: input.severity ?? 'error',
      }),
    ).catch(() => {
      /* A logger that reports its own failure is a loop. */
    });
  } catch {
    /* Never let telemetry break a collection. */
  }
}

export default logCollectionError;
