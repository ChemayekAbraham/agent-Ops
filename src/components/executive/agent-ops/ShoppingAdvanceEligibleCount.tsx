import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export function ShoppingAdvanceEligibleCount() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['agent-ops-shopping-advance-qualified-senders'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('agent_ops_shopping_advance_qualified_senders');
      if (error) throw error;
      if (data === null) throw new Error('Not authorized to view this count');
      return Number(data);
    },
    staleTime: 60_000,
    refetchOnMount: 'always',
  });

  return (
    <div className="border-b border-border pb-4">
      <p className="text-sm font-medium text-muted-foreground">Users qualified through wallet transfers</p>
      <p className="mt-1 text-3xl font-bold text-foreground" aria-live="polite">
        {isLoading ? '—' : isError ? 'Unavailable' : data?.toLocaleString('en-US')}
      </p>
      <p className="mt-2 text-sm text-muted-foreground">
        Each person who has sent money to another Welile wallet is counted once, including past transfers.
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        Qualification is informational; it does not issue an advance or make a wallet balance spendable.
      </p>
    </div>
  );
}