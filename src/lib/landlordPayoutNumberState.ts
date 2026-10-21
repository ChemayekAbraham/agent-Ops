/**
 * What the agent's landlord payout screen should say about the landlord's payout number.
 *
 * The old screen collapsed every blocked case into "This number changed after approval", including landlords that were never approved
 * (rejected, unverified) and landlords with no approved number at all. Each case now has its own state and wording.
 * `approvedNumber` is landlords.verified_mobile_money_number, the only number a payout may go to; `onFileNumber` is what is on the record.
 * No emojis; "Rent Plan" never "loan".
 */
export type PayoutNumberState =
  | 'ready'
  | 'ready_differs_from_record'
  | 'landlord_rejected'
  | 'landlord_unverified'
  | 'approved_number_missing'
  | 'no_number';

export interface PayoutNumberStateInput {
  verificationStatus?: string | null;
  verified?: boolean | null;
  verificationReason?: string | null;
  approvedNumber?: string | null;
  onFileNumber?: string | null;
}

export interface PayoutNumberStateResult {
  state: PayoutNumberState;
  tone: 'ok' | 'info' | 'blocked';
  title: string;
  detail: string;
  canSendOtp: boolean;
}

const last9 = (v?: string | null) => (v ?? '').replace(/\D/g, '').slice(-9);

export function landlordPayoutNumberState(i: PayoutNumberStateInput): PayoutNumberStateResult {
  const status = (i.verificationStatus ?? '').toLowerCase();
  const verified = status === 'verified' || (!status && i.verified === true);
  const approved = (i.approvedNumber ?? '').trim();
  const onFile = (i.onFileNumber ?? '').trim();

  if (status === 'rejected') {
    const why = (i.verificationReason ?? '').trim();
    return {
      state: 'landlord_rejected',
      tone: 'blocked',
      title: 'This landlord was rejected by Landlord Ops',
      detail: `${why ? `Reason: ${why}. ` : ''}No payout can be made to this landlord. Return the money to the CFO, or ask Landlord Ops to verify the landlord again.`,
      canSendOtp: false,
    };
  }
  if (!verified) {
    return {
      state: 'landlord_unverified',
      tone: 'blocked',
      title: 'This landlord is not verified yet',
      detail: 'A payout can only go to a landlord that Landlord Ops has verified. Ask Landlord Ops to verify the landlord first.',
      canSendOtp: false,
    };
  }
  if (!approved) {
    return {
      state: 'approved_number_missing',
      tone: 'blocked',
      title: 'No payout number has been approved for this landlord',
      detail: onFile
        ? 'The landlord is verified, but Landlord Ops has not approved a payout number. Ask Landlord Ops to confirm the number on the record.'
        : 'The landlord is verified, but has no payout number. Ask Landlord Ops to add and confirm one.',
      canSendOtp: false,
    };
  }
  if (onFile && last9(onFile) !== last9(approved)) {
    return {
      state: 'ready_differs_from_record',
      tone: 'info',
      title: 'The approved number differs from the number on the landlord record',
      detail: 'The payout goes to the number Landlord Ops approved. If the landlord says it is wrong, ask Landlord Ops to confirm which number is correct before sending the OTP.',
      canSendOtp: true,
    };
  }
  return {
    state: 'ready',
    tone: 'ok',
    title: 'Matches the number approved by Landlord Ops',
    detail: 'Locked. It cannot be changed here.',
    canSendOtp: true,
  };
}
