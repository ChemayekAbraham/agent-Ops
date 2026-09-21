import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface RegistrationControlRow {
  agent_id: string;
  full_name: string | null;
  phone: string | null;
  active_tenants: number;
  prev_expected: number;
  prev_collected: number;
  prev_pct: number | null;
  basis: string;
  period_start: string;
  period_end: string;
  restricted: boolean;
  blocked: boolean;
  override_id: string | null;
  override_reason: string | null;
  override_by: string | null;
  override_at: string | null;
  override_expires: string | null;
  district?: string | null;
  region?: string | null;
  tier?: string | null;
  group_id?: string | null;
  group_label?: string | null;
  group_min_active_tenants?: number | null;
  group_required_pct?: number | null;
  in_scope?: boolean;
}

export interface RegistrationOverrideRecord {
  id: string;
  agent_id: string;
  agent_name: string | null;
  approved_by: string;
  approved_by_name: string | null;
  reason: string;
  previous_state: Record<string, unknown>;
  new_state: Record<string, unknown>;
  active: boolean;
  expires_at: string | null;
  created_at: string;
  revoked_at: string | null;
  revoke_reason: string | null;
}

export interface RegistrationRuleGroup {
  id: string;
  label: string;
  active: boolean;
  min_active_tenants: number;
  max_active_tenants: number | null;
  required_prev_month_pct: number;
  districts: string[];
  regions: string[];
  tiers: string[];
  agent_ids: string[];
}

export interface RegistrationControlRules {
  enabled: boolean;
  min_active_tenants: number;
  required_prev_month_pct: number;
  groups: RegistrationRuleGroup[];
}

export interface RegistrationControlOptions {
  districts: string[];
  regions: string[];
  tiers: string[];
  agents: { id: string; full_name: string | null }[];
}

export interface RegistrationControlData {
  as_of: string;
  rules: RegistrationControlRules;
  options?: RegistrationControlOptions;
  totals: {
    agents: number;
    at_threshold: number;
    restricted: number;
    blocked: number;
    overridden: number;
  };
  rows: RegistrationControlRow[];
  overrides: RegistrationOverrideRecord[];
}

export function useAgentRegistrationControl(params: {
  search?: string;
  status?: 'all' | 'blocked' | 'restricted' | 'overridden' | 'clear';
  limit?: number;
} = {}) {
  const { search = '', status = 'all', limit = 100 } = params;
  return useQuery({
    queryKey: ['agent-registration-control', search, status, limit],
    queryFn: async (): Promise<RegistrationControlData> => {
      const { data, error } = await supabase.rpc('get_agent_registration_control', {
        p_search: search || null,
        p_status: status,
        p_limit: limit,
        p_offset: 0,
      });
      if (error) throw error;
      return data as unknown as RegistrationControlData;
    },
    staleTime: 60_000,
  });
}

export function useGrantRegistrationOverride() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { agentId: string; reason: string; days: number }) => {
      const { data, error } = await supabase.rpc('grant_agent_registration_override', {
        p_agent_id: vars.agentId,
        p_reason: vars.reason,
        p_days: vars.days,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['agent-registration-control'] }),
  });
}

export function useRevokeRegistrationOverride() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { overrideId: string; reason: string }) => {
      const { data, error } = await supabase.rpc('revoke_agent_registration_override', {
        p_override_id: vars.overrideId,
        p_reason: vars.reason,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['agent-registration-control'] }),
  });
}

export function useSaveRegistrationControlRules() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (rules: RegistrationControlRules) => {
      const { data, error } = await supabase.rpc('set_agent_registration_gate_rules', {
        p_rules: rules as unknown as never,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['agent-registration-control'] }),
  });
}
