import { supabase } from '@/integrations/supabase/client';

export type StandingOrderAction = 'create' | 'pause' | 'resume' | 'cancel';

interface LogParams {
  scheduledPayoutId?: string | null;
  action: StandingOrderAction;
  targetUserId?: string | null;
  recipientName?: string | null;
  amount?: number | null;
  reason?: string | null;
  scheduleDescription?: string | null;
  details?: Record<string, unknown>;
}

/**
 * Records a standing-order lifecycle action (create / pause / resume / cancel)
 * to the standing_order_audit_log with the acting user and a timestamp.
 * Best-effort: never throws so it cannot break the primary action.
 */
export async function logStandingOrderAction(params: LogParams): Promise<void> {
  try {
    const { data: userData } = await supabase.auth.getUser();
    const user = userData.user;
    if (!user) return;

    let actedByName: string | null = null;
    const { data: profile } = await supabase
      .from('profiles')
      .select('full_name')
      .eq('id', user.id)
      .maybeSingle();
    actedByName = (profile as any)?.full_name ?? user.email ?? null;

    await supabase.from('standing_order_audit_log').insert({
      scheduled_payout_id: params.scheduledPayoutId ?? null,
      action: params.action,
      acted_by: user.id,
      acted_by_name: actedByName,
      target_user_id: params.targetUserId ?? null,
      recipient_name: params.recipientName ?? null,
      amount: params.amount ?? null,
      reason: params.reason ?? null,
      schedule_description: params.scheduleDescription ?? null,
      details: (params.details ?? {}) as any,
    });
  } catch (err) {
    console.error('[standingOrderAudit] failed to log action:', err);
  }
}
