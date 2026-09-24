import { useQuery } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { db } from './useRd';

export const VALUES = ['hope', 'faith', 'love'] as const;
export const VALUE_LABEL: Record<string, string> = { hope: 'Hope', faith: 'Faith', love: 'Love' };

export type Product = { id: string; name: string; active: boolean };

export function useProducts() {
  return useQuery({
    queryKey: ['rd', 'products'],
    queryFn: async () => {
      const { data, error } = await db.from('rd_products').select('id,name,active').order('name');
      if (error) throw error;
      return (data ?? []) as Product[];
    },
  });
}

export function useProductName() {
  const { data = [] } = useProducts();
  const map = new Map(data.map((p) => [p.id, p.name]));
  return (id?: string | null) => (id ? map.get(id) ?? null : null);
}

export function ValueChip({ value }: { value?: string | null }) {
  if (!value || !VALUE_LABEL[value]) return null;
  return <Badge variant="secondary" className="text-[10px]">{VALUE_LABEL[value]}</Badge>;
}
