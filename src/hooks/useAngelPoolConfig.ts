import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { TOTAL_POOL_UGX, TOTAL_SHARES, PRICE_PER_SHARE, POOL_PERCENT } from '@/components/angel-pool/constants';
import { toast } from 'sonner';

export interface AngelPoolConfig {
  id: string;
  total_pool_ugx: number;
  total_shares: number;
  price_per_share: number;
  pool_equity_percent: number;
  updated_at: string | null;
  updated_by: string | null;
}

const DEFAULTS: Omit<AngelPoolConfig, 'id' | 'updated_at' | 'updated_by'> = {
  total_pool_ugx: TOTAL_POOL_UGX,
  total_shares: TOTAL_SHARES,
  price_per_share: PRICE_PER_SHARE,
  pool_equity_percent: POOL_PERCENT,
};

export function useAngelPoolConfig() {
  const qc = useQueryClient();

  const query = useQuery({
    queryKey: ['angel-pool-config'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('angel_pool_config')
        .select('*')
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      if (!data) return { ...DEFAULTS, id: '', updated_at: null, updated_by: null } as AngelPoolConfig;
      return data as AngelPoolConfig;
    },
  });

  const updateConfig = useMutation({
    mutationFn: async (values: Partial<Omit<AngelPoolConfig, 'id' | 'updated_at' | 'updated_by'>>) => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const existing = query.data;
      if (existing?.id) {
        const { error } = await supabase
          .from('angel_pool_config')
          .update({ ...values, updated_at: new Date().toISOString(), updated_by: user.id })
          .eq('id', existing.id);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from('angel_pool_config')
          .insert({ ...values, updated_by: user.id });
        if (error) throw error;
      }

      // Audit log
      await supabase.from('audit_logs').insert({
        user_id: user.id,
        action_type: 'angel_pool_config_update',
        table_name: 'angel_pool_config',
        metadata: values as any,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['angel-pool-config'] });
      toast.success('Pool settings updated');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return { config: query.data ?? ({ ...DEFAULTS, id: '', updated_at: null, updated_by: null } as AngelPoolConfig), isLoading: query.isLoading, updateConfig };
}
