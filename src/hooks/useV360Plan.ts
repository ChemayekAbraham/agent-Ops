import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/** 360-day Rent Plan reads and agent actions. The server decides every figure. */
const rpc = (fn: string, args: Record<string, unknown>) =>
  (supabase.rpc.bind(supabase) as unknown as (f: string, a: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>)(fn, args);

export interface V360Summary {
  pricing_version: string; daily_rate: number | null; gross: number | null;
  partner_monthly: number; partner_12_months: number;
  paid_days: number; missed_days: number; vacant_days: number;
  remaining_receivable: number; maturity_on: string | null; buffer_drawn: number;
}

export function useV360PlanSummary(rentRequestId: string | null | undefined) {
  return useQuery({
    queryKey: ['v360-summary', rentRequestId],
    enabled: !!rentRequestId,
    queryFn: async () => {
      const { data, error } = await rpc('v360_plan_summary', { p_rent_request_id: rentRequestId });
      if (error) throw new Error(error.message);
      return data as V360Summary | null;
    },
  });
}

export function useV360MarkDay() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (a: { rentRequestId: string; kind: 'vacant' | 'missed'; reason: string }) => {
      const { data, error } = await rpc('v360_mark_day', { p_rent_request_id: a.rentRequestId, p_kind: a.kind, p_reason: a.reason.trim() });
      if (error) throw new Error(error.message);
      return data;
    },
    onSuccess: (_d, a) => qc.invalidateQueries({ queryKey: ['v360-summary', a.rentRequestId] }),
  });
}

export function useV360GuestTenant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (a: { rentRequestId: string; guestTenantId: string; reason: string }) => {
      const { data, error } = await rpc('v360_guest_tenant', { p_rent_request_id: a.rentRequestId, p_guest_tenant_id: a.guestTenantId, p_reason: a.reason.trim() });
      if (error) throw new Error(error.message);
      return data;
    },
    onSuccess: (_d, a) => qc.invalidateQueries({ queryKey: ['v360-summary', a.rentRequestId] }),
  });
}

export interface V360SettingsRow {
  new_plans_enabled: boolean;
  updated_at: string;
  updated_by: string | null;
}

/** Read-only. The row is inserted with new_plans_enabled = false. */
export function useV360Settings(enabled = true) {
  return useQuery({
    queryKey: ['v360-settings'],
    enabled,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('v360_settings')
        .select('new_plans_enabled, updated_at, updated_by')
        .eq('id', true)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return (data as V360SettingsRow | null) ?? null;
    },
  });
}

/** CFO, COO, or super admin. Does not change the switch unless the caller passes a value. */
export function useV360SetNewPlansEnabled() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (enabled: boolean) => {
      const { data, error } = await supabase.rpc('v360_set_new_plans_enabled', { p_enabled: enabled });
      if (error) throw new Error(error.message);
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['v360-settings'] }),
  });
}
