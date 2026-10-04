// Single client-side entry point for landlord verification changes.
//
// The database rejects any direct UPDATE of the landlord verification columns
// (trigger `trg_aa_landlord_verification_gate`). `set_landlord_verification()`
// is the only authorized write path: it sets the state, keeps the derived
// `verified` flag in sync, resolves the open verification request, writes the
// audit log + append-only transition event, notifies the agent/tenant and
// applies the agent rejection charge.
import { supabase } from '@/integrations/supabase/client';

export type LandlordVerificationStatus = 'pending' | 'verified' | 'rejected' | 'resubmitted';

/** Where the decision came from — keeps human vs automatic verification separable forever. */
export type LandlordVerificationSource =
  | 'ops_manual'
  | 'ops_queue'
  | 'agent_request'
  | 'verification_detail'
  | 'global_hub'
  | 'pipeline_auto';

export interface SetLandlordVerificationResult {
  ok: boolean;
  landlord_id: string;
  status: LandlordVerificationStatus;
  source: string;
  agent_id: string | null;
  agent_charged: boolean;
  charge_amount: number;
}

export const MIN_VERIFICATION_REASON_LENGTH = 10;

export async function setLandlordVerification(params: {
  landlordId: string;
  status: LandlordVerificationStatus;
  reason: string;
  source: LandlordVerificationSource;
}): Promise<SetLandlordVerificationResult> {
  const reason = (params.reason || '').trim();
  if (reason.length < MIN_VERIFICATION_REASON_LENGTH) {
    throw new Error(`Please give at least ${MIN_VERIFICATION_REASON_LENGTH} characters explaining this decision.`);
  }
  const { data, error } = await (supabase.rpc as any)('set_landlord_verification', {
    p_landlord_id: params.landlordId,
    p_status: params.status,
    p_reason: reason,
    p_source: params.source,
  });
  if (error) throw error;
  return data as SetLandlordVerificationResult;
}

/** Presentation tokens for a landlord verification state (semantic classes only). */
export const VERIFICATION_STATUS_META: Record<
  LandlordVerificationStatus,
  { label: string; chipClass: string }
> = {
  verified: { label: 'Verified', chipClass: 'bg-emerald-100 text-emerald-700' },
  pending: { label: 'Pending', chipClass: 'bg-amber-100 text-amber-700' },
  rejected: { label: 'Rejected', chipClass: 'bg-destructive/10 text-destructive' },
  resubmitted: { label: 'Resubmitted', chipClass: 'bg-sky-100 text-sky-700' },
};

export function verificationSourceLabel(source: string | null | undefined): string {
  switch (source) {
    case 'pipeline_auto':
      return 'Auto (rent pipeline)';
    case 'agent_request':
      return 'Agent request review';
    case 'ops_queue':
      return 'Ops queue';
    case 'verification_detail':
      return 'Verification request';
    case 'global_hub':
      return 'Verification hub';
    case 'ops_manual':
      return 'Ops decision';
    case 'ops_reversal':
      return 'Ops reversed a verification';
    case 'registration':
      return 'Registration (not reviewed)';
    default:
      if (source?.startsWith('backfill')) return 'Reconciled (historic)';
      return source || 'Unknown';
  }
}