import { describe, it, expect } from 'vitest';
import { landlordPayoutNumberState } from '@/lib/landlordPayoutNumberState';
import { landlordRejectedGate, landlordRejectedErrorText } from '@/lib/landlordRejectedGate';

describe('landlordPayoutNumberState', () => {
  it('a rejected landlord is blocked and the old "changed after approval" wording is gone', () => {
    const r = landlordPayoutNumberState({ verificationStatus: 'rejected', verificationReason: 'Number for landlord is unreachable', onFileNumber: '0709203352' });
    expect(r.state).toBe('landlord_rejected');
    expect(r.canSendOtp).toBe(false);
    expect(r.detail).toContain('unreachable');
    expect(JSON.stringify(r)).not.toMatch(/changed after approval/i);
  });

  it('unverified, missing approved number and no number are blocked states', () => {
    expect(landlordPayoutNumberState({ verificationStatus: 'pending', onFileNumber: '0700000001' }).state).toBe('landlord_unverified');
    expect(landlordPayoutNumberState({ verificationStatus: 'verified', onFileNumber: '0700000001' }).state).toBe('approved_number_missing');
    const none = landlordPayoutNumberState({ verificationStatus: 'verified' });
    expect(none.state).toBe('approved_number_missing');
    expect(none.canSendOtp).toBe(false);
  });

  it('an approved number that differs from the registered number is blocked', () => {
    const r = landlordPayoutNumberState({ verificationStatus: 'verified', approvedNumber: '0742799042', onFileNumber: '0749889347' });
    expect(r.state).toBe('ready_differs_from_record');
    expect(r.canSendOtp).toBe(false);
    expect(r.tone).toBe('blocked');
    expect(r.title).toContain('does not match the number registered');
  });

  it('matching numbers in different formats are ready', () => {
    const r = landlordPayoutNumberState({ verificationStatus: 'verified', approvedNumber: '+256 777 990 220', onFileNumber: '0777990220' });
    expect(r.state).toBe('ready');
  });

  it('uses no emojis and no forbidden terms', () => {
    const all = JSON.stringify(['rejected', 'pending', 'verified'].map((s) => landlordPayoutNumberState({ verificationStatus: s })));
    expect(all).not.toMatch(/loan|lender|\bROI\b/i);
    expect(all).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});

describe('landlordRejectedGate', () => {
  it('blocks only rejected landlords, with the reason', () => {
    expect(landlordRejectedGate({ landlord_verification_status: 'verified' }).blocked).toBe(false);
    expect(landlordRejectedGate(null).blocked).toBe(false);
    const g = landlordRejectedGate({ landlord_name: 'Amina', landlord_verification_status: 'rejected', landlord_rejection_reason: 'Unreachable' });
    expect(g.blocked).toBe(true);
    expect(g.description).toContain('Amina was rejected by Landlord Ops (reason: Unreachable)');
  });

  it('turns the database error into plain text', () => {
    expect(landlordRejectedErrorText('LANDLORD_REJECTED: Amina was rejected by Landlord Ops. Do X.')).toBe('Amina was rejected by Landlord Ops. Do X.');
    expect(landlordRejectedErrorText('something else')).toBeNull();
  });
});
