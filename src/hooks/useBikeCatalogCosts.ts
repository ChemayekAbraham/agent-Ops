import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { DEFAULT_MOTORBIKES } from '@/components/executive/agent-ops/MotorBikeCatalogDialog';

/**
 * Supplier cost per bike model, read from the merchandise catalog
 * (`merchandise_catalog.unit_cost`, matched case-insensitively on item_name).
 * Falls back to built-in DEFAULT_MOTORBIKES if not yet overridden in the database.
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

      // Seed baseline built-in motorbike costs
      for (const def of DEFAULT_MOTORBIKES) {
        const name = def.item_name.trim().toLowerCase();
        if (def.unit_cost && def.unit_cost > 0) {
          map.set(name, def.unit_cost);
          const shortName = name.replace(/^spiro\s+/, '');
          if (shortName && !map.has(shortName)) map.set(shortName, def.unit_cost);
        }
      }

      // Overlay database rows (overriding defaults if updated in DB)
      for (const r of data ?? []) {
        const name = String(r.item_name ?? '').trim().toLowerCase();
        const cost = Number(r.unit_cost);
        if (name && Number.isFinite(cost) && cost > 0) {
          map.set(name, cost);
          const shortName = name.replace(/^spiro\s+/, '');
          if (shortName && !map.has(shortName)) map.set(shortName, cost);
        }
      }
      return map;
    },
  });
  return (model: string | null | undefined): number | null => {
    if (!model || !data) return null;
    const clean = model.trim().toLowerCase();
    return data.get(clean) ?? data.get(clean.replace(/^spiro\s+/, '')) ?? null;
  };
}

/** Profit = valuation − supplier cost; null when the cost is unknown. */
export function bikeProfit(valuation: number, cost: number | null): number | null {
  return cost == null ? null : valuation - cost;
}
