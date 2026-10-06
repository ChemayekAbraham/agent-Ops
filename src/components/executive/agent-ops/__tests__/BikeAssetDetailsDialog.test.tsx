import { describe, it, expect, vi } from 'vitest';

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: () => ({ select: () => Promise.resolve({ data: [] }) }),
    rpc: () => Promise.resolve({ data: null, error: null }),
  },
}));

import { generateDefaultGpsTrackerId } from '../BikeAssetDetailsDialog';
import type { BikeLeaseRecord } from '@/hooks/useBikeLeases';

describe('BikeAssetDetailsDialog - GPS Tracker ID auto-fill', () => {
  it('returns existing gps_tracker_id when already present', () => {
    const lease = {
      lease_id: 'lease-123',
      tracking_reference: 'SPB-B883160B',
      gps_tracker_id: 'GPS-CUSTOM-999',
    } as unknown as BikeLeaseRecord;

    expect(generateDefaultGpsTrackerId(lease)).toBe('GPS-CUSTOM-999');
  });

  it('auto-fills GPS Tracker ID from tracking reference when empty', () => {
    const lease = {
      lease_id: 'lease-123',
      tracking_reference: 'SPB-B883160B',
      gps_tracker_id: '',
    } as unknown as BikeLeaseRecord;

    expect(generateDefaultGpsTrackerId(lease)).toBe('GPS-SP-B883160B');
  });

  it('auto-fills GPS Tracker ID from lease ID when tracking reference is absent', () => {
    const lease = {
      lease_id: '43e6c2e1-18a6-4503-badb-5bb6c23491cc',
      tracking_reference: null,
      gps_tracker_id: null,
    } as unknown as BikeLeaseRecord;

    expect(generateDefaultGpsTrackerId(lease)).toBe('GPS-SP-43E6C2E1');
  });
});
