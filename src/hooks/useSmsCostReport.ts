/**
 * SMS cost/usage report — for reconciling actual spend against Yoola credit
 * top-ups. Backed by get_sms_cost_report, which computes cost independently
 * from message length (30 UGX per GSM-7/UCS-2 segment) rather than trusting
 * sms_delivery_log.cost, the provider's own self-reported figure — that
 * column is only populated for ~70% of Yoola rows and contains clear errors
 * in the rest (see the migration's comment for specifics).
 *
 * Data-fetching only — this file is Claude's lane (src/hooks/). Any
 * cards/tables/buttons consuming this belong in src/components/ per
 * CLAUDE.md's division of labor.
 */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface SmsCostTotals {
  messages: number;
  segments: number;
  cost_ugx: number;
  sent: number;
  failed: number;
  cost_ugx_sent_only: number;
}

export interface SmsCostDailyRow {
  day: string; // yyyy-MM-dd
  messages: number;
  segments: number;
  cost_ugx: number;
  yoola_messages: number;
  yoola_cost_ugx: number;
  at_messages: number;
  at_cost_ugx: number;
  other_messages: number;
  other_cost_ugx: number;
}

export interface SmsCostProviderRow {
  provider: string;
  messages: number;
  segments: number;
  cost_ugx: number;
}

export interface SmsCostSourceRow {
  source: string;
  messages: number;
  segments: number;
  cost_ugx: number;
}

export interface SmsCostReport {
  start_date: string;
  end_date: string;
  provider_filter: string | null;
  totals: SmsCostTotals;
  daily: SmsCostDailyRow[];
  by_provider: SmsCostProviderRow[];
  by_source: SmsCostSourceRow[];
  generated_at: string;
}

interface SmsCostReportFilters {
  startDate: string; // yyyy-MM-dd
  endDate: string; // yyyy-MM-dd
  provider?: string | null;
}

export function useSmsCostReport(filters: SmsCostReportFilters) {
  const { startDate, endDate, provider = null } = filters;

  return useQuery({
    queryKey: ['sms-cost-report', startDate, endDate, provider],
    queryFn: async (): Promise<SmsCostReport> => {
      const { data, error } = await (supabase.rpc as any)('get_sms_cost_report', {
        p_start: startDate,
        p_end: endDate,
        p_provider: provider,
      });
      if (error) throw error;
      return data as unknown as SmsCostReport;
    },
    staleTime: 2 * 60 * 1000,
  });
}
