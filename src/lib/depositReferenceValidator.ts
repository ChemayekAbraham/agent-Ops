import { invokeEdgeFunction } from './invokeEdgeFunction';

export type DepositReferenceReason =
  | 'ok'
  | 'placeholder'
  | 'duplicate_transaction_id'
  | 'duplicate_in_notes';

export interface DepositReferenceConflict {
  deposit_id: string;
  status: string;
  matched_field: 'transaction_id' | 'notes';
}

export interface DepositReferenceResult {
  valid: boolean;
  reason: DepositReferenceReason;
  message: string;
  conflict: DepositReferenceConflict | null;
}

/**
 * Pre-flight check that mirrors the `guard_deposit_reference_uniqueness`
 * trigger. Use on debounced TID input + as a final guard on submit so the
 * UI shows the same outcome the DB would return without ever attempting a
 * duplicate insert.
 *
 * Network/auth failures soft-fail to `valid:true reason:'ok'` — the DB
 * trigger remains the authoritative gate.
 */
export async function validateDepositReference(
  transactionId: string,
  excludeDepositId?: string | null,
): Promise<DepositReferenceResult> {
  const { data, error } = await invokeEdgeFunction<DepositReferenceResult>(
    'validate-deposit-reference',
    {
      body: {
        transaction_id: transactionId,
        exclude_deposit_id: excludeDepositId ?? null,
      },
      silent: true,
    },
  );
  if (error || !data) {
    return {
      valid: true,
      reason: 'ok',
      message: 'Pre-flight unavailable — falling back to server-side guard.',
      conflict: null,
    };
  }
  return data;
}
