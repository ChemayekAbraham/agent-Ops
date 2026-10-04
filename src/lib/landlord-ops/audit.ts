import { supabase } from "@/integrations/supabase/client";

/**
 * Client-side audit helper for remaining non-transactional actions.
 * State-changing operations should audit inside their RPC / edge fn instead.
 *
 * The acting user id is intentionally NOT accepted from the caller — the DB
 * has `user_id uuid default auth.uid()` on `audit_logs`, so RLS + the auth
 * session decide the actor. This prevents the browser from impersonating
 * another user through this helper.
 */
export interface AuditEntry {
  actionType: string;
  tableName: string;
  recordId: string;
  metadata?: Record<string, unknown>;
}

export async function logAudit(entry: AuditEntry): Promise<{ error: Error | null }> {
  try {
    const { error } = await (supabase.from("audit_logs") as any).insert({
      action_type: entry.actionType,
      table_name: entry.tableName,
      record_id: entry.recordId,
      metadata: entry.metadata ?? {},
    });
    if (error) throw error;
    return { error: null };
  } catch (err) {
    // Never crash the caller — audit is best-effort at the client tier.
    // Server-side RPC audits are the source of truth for state changes.
    console.warn("[landlord-ops/audit] insert failed", err);
    return { error: err instanceof Error ? err : new Error(String(err)) };
  }
}
