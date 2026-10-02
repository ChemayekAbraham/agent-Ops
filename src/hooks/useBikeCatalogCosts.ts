import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/**
 * Supplier cost per bike model, read from the merchandise catalog
 * (`merchandise_catalog.unit_cost`, matched case-insensitively on item_name).
 * Returns a lookup that yields null when the model is not in the catalog.
 */
export function useBikeCatalogCosts() {
  const { data } = useQuery({
    queryKey: ['bike-catalog-costs'],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('merchandise_catalog')
        .select('item_name, unit_cost');
      if (error) throw error;
      const map = new Map<string, number>();
      for (const r of data ?? []) {
        const name = String(r.item_name ?? '').trim().toLowerCase();
        const cost = Number(r.unit_cost);
        if (name && Number.isFinite(cost) && cost > 0) map.set(name, cost);
      }
      return map;
    },
  });
  return (model: string | null | undefined): number | null => {
    if (!model || !data) return null;
    return data.get(model.trim().toLowerCase()) ?? null;
  };
}

/** Profit = valuation − supplier cost; null when the cost is unknown. */
export function bikeProfit(valuation: number, cost: number | null): number | null {
  return cost == null ? null : valuation - cost;
}
