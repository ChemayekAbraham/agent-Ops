import { supabase } from '@/integrations/supabase/client';

export type LendingAuditAction =
  | 'offer_created'
  | 'offer_activated'
  | 'offer_deactivated'
  | 'offer_deleted'
  | 'request_created'
  | 'request_approved'
  | 'request_declined'
  | 'loan_disbursed'
  | 'fee_deducted'
  | 'repayment_recorded'
  | 'status_change';

export interface LendingAuditEntry {
  actorId: string;
  actorDisplayName?: string | null;
  actionType: LendingAuditAction;
  entityType: 'offer' | 'request' | 'loan';
  entityId?: string | null;
  borrowerUserId?: string | null;
  lenderAgentId?: string | null;
  amountUgx?: number | null;
  feeUgx?: number | null;
  oldStatus?: string | null;
  newStatus?: string | null;
  details?: Record<string, unknown>;
}

/**
 * Records a lending marketplace audit event. Best-effort: failures are logged
 * but never block the underlying action.
 */
export async function logLendingAudit(entry: LendingAuditEntry): Promise<void> {
  try {
    const { error } = await (supabase.from('lending_audit_log' as any).insert({
      actor_id: entry.actorId,
      actor_display_name: entry.actorDisplayName ?? null,
      action_type: entry.actionType,
      entity_type: entry.entityType,
      entity_id: entry.entityId ?? null,
      borrower_user_id: entry.borrowerUserId ?? null,
      lender_agent_id: entry.lenderAgentId ?? null,
      amount_ugx: entry.amountUgx ?? null,
      fee_ugx: entry.feeUgx ?? null,
      old_status: entry.oldStatus ?? null,
      new_status: entry.newStatus ?? null,
      details: entry.details ?? {},
    }) as any);
    if (error) console.error('[logLendingAudit]', error.message);
  } catch (e) {
    console.error('[logLendingAudit] unexpected', e);
  }
}