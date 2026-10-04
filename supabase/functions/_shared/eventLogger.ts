/**
 * Log a system event via the log_system_event RPC.
 * Fire-and-forget — errors are logged but never thrown.
 */
export async function logSystemEvent(
  // Use a structural `any` here: edge functions import @supabase/supabase-js
  // from multiple sources (esm.sh @2 vs npm:@2) which Deno treats as
  // distinct nominal types. Typing as `any` lets either client be passed in.
  // deno-lint-ignore no-explicit-any
  adminClient: any,
  eventType: string,
  userId: string,
  entityType?: string,
  entityId?: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  try {
    await adminClient.rpc("log_system_event", {
      p_event_type: eventType,
      p_user_id: userId,
      p_related_entity_type: entityType ?? null,
      p_related_entity_id: entityId ?? null,
      p_metadata: metadata ?? {},
    });
  } catch (err) {
    console.error(`[eventLogger] Failed to log ${eventType}:`, err);
  }
}
