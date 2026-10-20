/**
 * Landlord Ops pipeline: a Rent Plan whose landlord was rejected cannot be verified (moved forward). The database enforces this
 * (trigger trg_block_review_rejected_landlord, error text starting LANDLORD_REJECTED); this is the same rule applied up front so the
 * reviewer sees a clear message instead of a failed save.
 */
export interface RejectedLandlordRequest {
  landlord_name?: string | null;
  landlord_verification_status?: string | null;
  landlord_rejection_reason?: string | null;
}

export interface LandlordRejectedBlock {
  blocked: boolean;
  title: string;
  description: string;
}

export function landlordRejectedGate(req: RejectedLandlordRequest | null | undefined): LandlordRejectedBlock {
  if (!req || (req.landlord_verification_status ?? '').toLowerCase() !== 'rejected') {
    return { blocked: false, title: '', description: '' };
  }
  const name = (req.landlord_name ?? '').trim() || 'This landlord';
  const why = (req.landlord_rejection_reason ?? '').trim();
  return {
    blocked: true,
    title: 'Landlord was rejected - Rent Plan cannot be verified',
    description:
      `${name} was rejected by Landlord Ops${why ? ` (reason: ${why})` : ''}. ` +
      'Verify the landlord again first, or return this Rent Plan to the agent to change the landlord.',
  };
}

/** Friendly text for the database error when the gate fires anyway (for example a stale screen). */
export function landlordRejectedErrorText(message?: string | null): string | null {
  if (!message || !message.includes('LANDLORD_REJECTED')) return null;
  return message.replace(/^[\s\S]*LANDLORD_REJECTED:\s*/, '').trim();
}
