import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/**
 * Single source of truth for receivables in the product.
 *
 * Every figure below comes from the server-side authoritative definition
 * (`v_receivables_lines`) through `get_receivables_total`,
 * `get_receivables_breakdown` and `get_receivables_forecast`.
 * Do NOT re-implement receivables maths in JS — add it to the view instead.
 */

const STALE_TIME = 5 * 60 * 1000;

export interface ReceivablesCategoryTotal {
  key: string;
  label: string;
  outstanding: number;
  item_count: number;
}

export interface ReceivablesTotal {
  currency: string;
  as_at: string;
  total: number;
  item_count: number;
  categories: ReceivablesCategoryTotal[];
  source: string;
}

export interface ReceivableItem {
  item_id: string;
  counterparty: string | null;
  amount: number;
  due_date: string | null;
  due_kind: 'scheduled' | 'projected';
  status: string | null;
  source: string;
}

export interface ReceivableProduct {
  key: string;
  label: string;
  source: string;
  outstanding: number;
  item_count: number;
  scheduled_amount: number;
  projected_amount: number;
  items: ReceivableItem[];
}

export interface ReceivablesBreakdownCategory {
  key: string;
  label: string;
  outstanding: number;
  item_count: number;
  products: ReceivableProduct[];
}

export interface ReceivablesBreakdown {
  currency: string;
  as_at: string;
  total: number;
  categories: ReceivablesBreakdownCategory[];
  validation: {
    categories_total: number;
    authoritative_total: number;
    difference: number;
    ties_out: boolean;
  };
  source: string;
}

export interface ReceivablesForecast {
  currency: string;
  today: string;
  range: { from: string; to: string };
  scheduled_total: number;
  projected_total: number;
  range_total: number;
  unscheduled_outstanding: number;
  days: Array<{ date: string; scheduled: number; projected: number; total: number }>;
  products: Array<{
    category_key: string;
    category_label: string;
    product_key: string;
    product_label: string;
    scheduled: number;
    projected: number;
    total: number;
  }>;
  projection_basis: {
    lookback_days: number;
    agent_collections: { sample_days: number; median_daily: number };
    business_advance_repayments: { sample_days: number; median_daily: number };
    credit_draw_ledger: { sample_days: number; median_daily: number };
  };
  source: string;
}

/** Authoritative Total Receivables + per-category totals. */
export function useReceivablesTotal() {
  return useQuery({
    queryKey: ['receivables-total'],
    queryFn: async (): Promise<ReceivablesTotal> => {
      const { data, error } = await supabase.rpc('get_receivables_total');
      if (error) throw error;
      return data as unknown as ReceivablesTotal;
    },
    staleTime: STALE_TIME,
  });
}

/** Category → product → item drill-down, with the tie-out validation block. */
export function useReceivablesBreakdown(enabled = true) {
  return useQuery({
    queryKey: ['receivables-breakdown'],
    enabled,
    queryFn: async (): Promise<ReceivablesBreakdown> => {
      const { data, error } = await supabase.rpc('get_receivables_breakdown');
      if (error) throw error;
      return data as unknown as ReceivablesBreakdown;
    },
    staleTime: STALE_TIME,
  });
}

/** Forecast for an explicit date window. Scheduled = exact dates, projected = estimated. */
export function useReceivablesForecast(from: string, to: string, enabled = true) {
  return useQuery({
    queryKey: ['receivables-forecast', from, to],
    enabled: enabled && !!from && !!to,
    queryFn: async (): Promise<ReceivablesForecast> => {
      const { data, error } = await supabase.rpc('get_receivables_forecast', {
        p_from: from,
        p_to: to,
      });
      if (error) throw error;
      return data as unknown as ReceivablesForecast;
    },
    staleTime: STALE_TIME,
  });
}
