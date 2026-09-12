/**
 * Read-only payment activity grouped by the approved Uganda location hierarchy:
 * Country -> Region -> District -> Sub-county -> Village, then the individual
 * receipts. Backed by the STABLE reporting RPCs
 * get_payments_location_breakdown / get_payments_location_receipts, which read
 * agent_collections (non-reversed) only. Nothing here writes or recalculates
 * payment or accounting data.
 */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

type RpcFn = (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;

const STALE_TIME = 60 * 1000;

export type PaymentsLocationLevel = 'country' | 'region' | 'district' | 'subcounty' | 'village';

export interface PaymentsLocationRow {
  label: string;
  country: string | null;
  region: string | null;
  district: string | null;
  district_id: number | null;
  subcounty_id: number | null;
  amount: number;
  payment_count: number;
  tenant_count: number;
  agent_count: number;
  first_payment_at: string | null;
  last_payment_at: string | null;
  fully_mapped: boolean;
}

export interface PaymentsLocationMethod {
  method: string;
  amount: number;
  payment_count: number;
}

export interface PaymentsLocationDailyPoint {
  date: string;
  amount: number;
  payment_count: number;
}

export interface PaymentsLocationBreakdown {
  currency: string;
  as_at: string;
  level: PaymentsLocationLevel;
  from: string | null;
  to: string | null;
  total: number;
  payment_count: number;
  tenant_count: number;
  located_amount: number;
  unmapped_amount: number;
  methods: PaymentsLocationMethod[];
  daily: PaymentsLocationDailyPoint[];
  rows: PaymentsLocationRow[];
  source: string;
}

export interface PaymentsLocationFilters {
  level: PaymentsLocationLevel;
  country?: string | null;
  region?: string | null;
  districtId?: number | null;
  subcountyId?: number | null;
  from?: string | null;
  to?: string | null;
  method?: string | null;
}

export function usePaymentsByLocation(filters: PaymentsLocationFilters, enabled = true) {
  const {
    level,
    country = null,
    region = null,
    districtId = null,
    subcountyId = null,
    from = null,
    to = null,
    method = null,
  } = filters;

  return useQuery({
    queryKey: ['payments-by-location', level, country, region, districtId, subcountyId, from, to, method],
    enabled,
    staleTime: STALE_TIME,
    queryFn: async (): Promise<PaymentsLocationBreakdown> => {
      const { data, error } = await (supabase.rpc as unknown as RpcFn)('get_payments_location_breakdown', {
        p_level: level,
        p_country: country,
        p_region: region,
        p_district_id: districtId,
        p_subcounty_id: subcountyId,
        p_from: from,
        p_to: to,
        p_method: method,
      });
      if (error) throw error;
      return data as PaymentsLocationBreakdown;
    },
  });
}

export interface PaymentReceipt {
  payment_id: string;
  tenant_id: string | null;
  tenant: string | null;
  phone: string | null;
  agent: string | null;
  amount: number;
  method: string | null;
  channel: string | null;
  transaction_id: string | null;
  tracking_id: string | null;
  is_partial: boolean | null;
  rent_request_id: string | null;
  paid_at: string;
  region: string | null;
  district: string | null;
  subcounty: string | null;
  village: string | null;
}

export interface PaymentsLocationReceipts {
  currency: string;
  as_at: string;
  level: PaymentsLocationLevel;
  group_label: string | null;
  total: number;
  payment_count: number;
  tenant_count: number;
  returned: number;
  payments: PaymentReceipt[];
  source: string;
}

export function usePaymentsAtLocation(
  filters: PaymentsLocationFilters & { groupLabel?: string | null; limit?: number },
  enabled = true
) {
  const {
    level,
    country = null,
    region = null,
    districtId = null,
    subcountyId = null,
    from = null,
    to = null,
    method = null,
    groupLabel = null,
    limit = 200,
  } = filters;

  return useQuery({
    queryKey: [
      'payments-at-location',
      level, country, region, districtId, subcountyId, from, to, method, groupLabel, limit,
    ],
    enabled,
    staleTime: STALE_TIME,
    queryFn: async (): Promise<PaymentsLocationReceipts> => {
      const { data, error } = await (supabase.rpc as unknown as RpcFn)('get_payments_location_receipts', {
        p_level: level,
        p_country: country,
        p_region: region,
        p_district_id: districtId,
        p_subcounty_id: subcountyId,
        p_group_label: groupLabel,
        p_from: from,
        p_to: to,
        p_method: method,
        p_limit: limit,
      });
      if (error) throw error;
      return data as PaymentsLocationReceipts;
    },
  });
}
