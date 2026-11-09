import { describe, it, expect } from 'vitest';
import {
  SIGNAGE_RATES,
  formatSignageStatus,
  type SignageStatus,
  type SignagePropertyType,
  signageReviewTarget,
  canReviewSignage,
  canInstallSignage,
  hasDeviceSignageGps,
  hasInstalledSignagePhoto,
  signagePipelineRecords,
} from '@/lib/welileSignages';

describe('Welile Signages business rules & configuration', () => {
  it('accepts only real device GPS', () => {
    const gps = { gps_latitude: 0.31, gps_longitude: 32.58, gps_accuracy_meters: 8, gps_captured_at: '2026-11-09T06:00:00Z' };
    expect(hasDeviceSignageGps({ ...gps, gps_source: 'device' })).toBe(true);
    expect(hasDeviceSignageGps(gps as any)).toBe(false);
  });
  it('requires an installed-board photo for activation', () => {
    expect(hasInstalledSignagePhoto([{ id: '1', url: 'data:image/webp;base64,a', category: 'installed_signage', taken_at: '' }])).toBe(true);
    expect(hasInstalledSignagePhoto([{ id: '1', url: 'data:image/webp;base64,a', category: 'exterior', taken_at: '' }])).toBe(false);
  });
  it('hides cancelled spots from the agent pipeline', () => {
    const rows = [{ status: 'cancelled' }, { status: 'rejected' }, { status: 'changes_required' }] as any;
    expect(signagePipelineRecords(rows).map((r: any) => r.status)).toEqual(['rejected', 'changes_required']);
  });
  it('routes Agent Ops approval to COO instead of installation', () => {
    expect(signageReviewTarget('approve', 'agent_ops')).toBe('awaiting_coo');
  });
  it('routes COO approval to installation', () => {
    expect(signageReviewTarget('approve', 'coo')).toBe('approved_for_installation');
  });
  it('blocks installation while awaiting COO', () => {
    expect(canInstallSignage('awaiting_coo')).toBe(false);
    expect(canInstallSignage('approved_for_installation')).toBe(true);
  });
  it('only allows COO decisions on applications awaiting COO', () => {
    expect(canReviewSignage('awaiting_coo', 'coo')).toBe(true);
    expect(canReviewSignage('submitted', 'coo')).toBe(false);
    expect(canReviewSignage('awaiting_coo', 'agent_ops')).toBe(false);
  });
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
    expect(formatSignageStatus('submitted').label).toBe('Pending');
    expect(formatSignageStatus('pending').label).toBe('Pending');
    expect(formatSignageStatus('rejected').label).toBe('Rejected');
    expect(formatSignageStatus('rejected').variant).toBe('destructive');
  });

  it('validates property types include busy houses and shops', () => {
    const validTypes: SignagePropertyType[] = ['house', 'shop', 'business_premise', 'mixed_use'];
    expect(validTypes).toContain('house');
    expect(validTypes).toContain('shop');
  });
});
