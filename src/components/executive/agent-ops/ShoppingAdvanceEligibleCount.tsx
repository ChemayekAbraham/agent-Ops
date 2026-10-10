import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { ShoppingAdvanceQualifiedUsersSheet } from './ShoppingAdvanceQualifiedUsersSheet';

export function ShoppingAdvanceEligibleCount() {
  const [open, setOpen] = useState(false);
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
    refetchInterval: 60_000,
  });

  return (
    <div className="border-b border-border pb-4">
      <p className="text-sm font-medium text-muted-foreground">Users qualified through wallet transfers</p>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={isLoading || isError}
        className="mt-1 text-3xl font-bold text-primary underline-offset-4 hover:underline disabled:text-foreground disabled:no-underline"
        aria-live="polite"
        aria-label="Open qualified users by location"
      >
        {isLoading ? '—' : isError ? 'Unavailable' : data?.toLocaleString('en-US')}
      </button>
      <p className="mt-2 text-sm text-muted-foreground">
        Users who received wallet transfers in the last 24 hours are counted once. Access returns to UGX 0 when no transfers remain in that window.
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        Qualification is informational; it does not issue an advance or make a wallet balance spendable.
      </p>
      <ShoppingAdvanceQualifiedUsersSheet open={open} onOpenChange={setOpen} />
    </div>
  );
}
