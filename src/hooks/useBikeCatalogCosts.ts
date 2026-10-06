import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { DEFAULT_MOTORBIKES } from '@/components/executive/agent-ops/MotorBikeCatalogDialog';

/**
 * Base price per bike model, read from the motorbike / merchandise catalog
 * (`merchandise_catalog.unit_price`, falling back to `unit_cost`, matched case-insensitively on item_name).
 * Falls back to built-in DEFAULT_MOTORBIKES if not yet overridden in the database.
 * Returns a lookup that matches the catalog and agent dashboard prices.
 */
export function useBikeCatalogCosts() {
  const { data } = useQuery({
    queryKey: ['bike-catalog-costs'],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('merchandise_catalog')
        .select('item_name, unit_price, unit_cost');
      if (error) throw error;
      const map = new Map<string, number>();

      // Seed baseline built-in motorbike prices from catalog defaults (unit_price first)
      for (const def of DEFAULT_MOTORBIKES) {
        const name = def.item_name.trim().toLowerCase();
        const price = Number(def.unit_price || def.unit_cost || 0);
        if (price > 0) {
          map.set(name, price);
          const shortName = name.replace(/^spiro\s+/, '');
          if (shortName && !map.has(shortName)) map.set(shortName, price);
        }
      }

      // Overlay database rows (overriding defaults if updated in DB)
      for (const r of data ?? []) {
        const name = String(r.item_name ?? '').trim().toLowerCase();
        const price = Number(r.unit_price) > 0 ? Number(r.unit_price) : Number(r.unit_cost);
        if (name && Number.isFinite(price) && price > 0) {
          map.set(name, price);
          const shortName = name.replace(/^spiro\s+/, '');
          if (shortName && !map.has(shortName)) map.set(shortName, price);
        }
      }
      return map;
    },
  });

  return (model: string | null | undefined): number | null => {
    if (!data) return null;
    const raw = (model || '').trim().toLowerCase();
    if (!raw) {
      return data.get('spiro bike') ?? data.get('spiro ekoride') ?? 159_600;
    }
    const clean = raw.replace(/\s+/g, ' ');
    const withoutSpiro = clean.replace(/^spiro\s+/, '');

    // Direct match
    if (data.has(clean)) return data.get(clean)!;
    if (data.has(withoutSpiro)) return data.get(withoutSpiro)!;
    if (data.has(`spiro ${clean}`)) return data.get(`spiro ${clean}`)!;

    // Keyword match for common Spiro model variants
    if (clean.includes('ekocycle')) return data.get('spiro ekocycle') ?? 145_000;
    if (clean.includes('ekoride')) return data.get('spiro ekoride') ?? 159_600;
    if (clean.includes('commando')) return data.get('spiro commando') ?? 185_000;
    if (clean.includes('macao')) return data.get('macao ev5500') ?? 500_000;
    if (clean.includes('bike') || clean.includes('spiro')) {
      return data.get('spiro bike') ?? data.get('spiro ekoride') ?? 159_600;
    }

    return null;
  };
}

/** Profit = valuation − catalog price; null when the cost is unknown. */
export function bikeProfit(valuation: number, cost: number | null): number | null {
  return cost == null ? null : valuation - cost;
}
