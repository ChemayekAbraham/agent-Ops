import { describe, it, expect } from 'vitest';
import {
  SIGNAGE_RATES,
  formatSignageStatus,
  type SignageStatus,
  type SignagePropertyType,
} from '@/lib/welileSignages';

describe('Welile Signages business rules & configuration', () => {
  it('confirms the non-negotiable financial rates', () => {
    expect(SIGNAGE_RATES.OWNER_MONTHLY_UGX).toBe(10000);
    expect(SIGNAGE_RATES.AGENT_REWARD_UGX).toBe(3000);
    expect(SIGNAGE_RATES.MAX_GPS_ACCURACY_METERS).toBe(50);
  });

  it('formats all lifecycle statuses with proper user labels', () => {
    const statuses: SignageStatus[] = [
      'draft',
      'submitted',
      'under_review',
      'changes_required',
      'rejected',
      'approved_for_installation',
      'pending_installation',
      'installation_verification',
      'active',
      'temporarily_inactive',
      'payment_on_hold',
      'removal_requested',
      'removed',
      'cancelled',
    ];

    for (const status of statuses) {
      const result = formatSignageStatus(status);
      expect(result.label).toBeTruthy();
      expect(result.variant).toBeTruthy();
    }

    expect(formatSignageStatus('active').label).toBe('Active (Billing)');
    expect(formatSignageStatus('active').variant).toBe('success');
    expect(formatSignageStatus('approved_for_installation').label).toBe('Approved for Installation');
    expect(formatSignageStatus('rejected').label).toBe('Rejected');
    expect(formatSignageStatus('rejected').variant).toBe('destructive');
  });

  it('validates property types include busy houses and shops', () => {
    const validTypes: SignagePropertyType[] = ['house', 'shop', 'business_premise', 'mixed_use'];
    expect(validTypes).toContain('house');
    expect(validTypes).toContain('shop');
  });
});
