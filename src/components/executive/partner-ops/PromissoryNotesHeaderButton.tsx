import { useEffect, useState } from 'react';
import { FileText } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { PROMISSORY_PENDING_COUNT_KEY, reconcilePromissoryPendingCount } from './promissoryPendingCount';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface PromissoryNotesHeaderButtonProps {
  variant?: 'default' | 'outline' | 'ghost';
  active?: boolean;
  className?: string;
  onClick?: () => void;
}

/**
 * Sticky Promissory Notes button shared across Partner Ops routes.
 * Keeps a live pending count and navigates to the Partner Ops Promissory Notes
 * queue (or calls the caller-supplied handler when rendered inside that queue).
 */
export function PromissoryNotesHeaderButton({
  variant,
  active = false,
  className,
  onClick,
}: PromissoryNotesHeaderButtonProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [isLive, setIsLive] = useState(false);

  const { data: promissoryPending = 0, refetch } = useQuery({
    queryKey: [...PROMISSORY_PENDING_COUNT_KEY],
    queryFn: async () => {
      const { count } = await supabase
        .from('promissory_notes')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'pending');
      return count || 0;
    },
    staleTime: 30000,
    // Realtime delivers instant updates; polling is the safety net. While the
    // socket is down we poll faster so the badge never looks stuck.
    refetchInterval: isLive ? 60000 : 15000,
    refetchIntervalInBackground: true,
  });

  // Live updates: any insert/update/delete on promissory_notes refreshes the
  // pending count so every mounted copy of this button stays in sync.
  useEffect(() => {
    const channel = supabase
      .channel('promissory-notes-pending-count')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'promissory_notes' },
        () => {
          refetch();
          reconcilePromissoryPendingCount(queryClient);
        },
      )
      .subscribe((status) => {
        // SUBSCRIBED = realtime stream confirmed open. Anything else
        // (joining, dropped, error) shows the fallback state.
        setIsLive(status === 'SUBSCRIBED');
      });
    return () => {
      supabase.removeChannel(channel);
    };
  }, [refetch, queryClient]);

  const handleClick = () => {
    if (onClick) {
      onClick();
      return;
    }
    navigate('/executive-hub?tab=partners-ops');
  };

  return (
    <Button
      variant={active ? 'default' : variant ?? 'outline'}
      size="sm"
      className={cn('relative gap-1.5 text-xs', className)}
      onClick={handleClick}
    >
      <FileText className="h-3.5 w-3.5" />
      <span className="hidden sm:inline">Promissory Notes</span>
      {promissoryPending > 0 && (
        <span className="ml-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold text-destructive-foreground">
          {promissoryPending > 99 ? '99+' : promissoryPending}
        </span>
      )}
      <span
        className={cn(
          'ml-0.5 inline-flex items-center gap-1 rounded-full border px-1.5 py-px text-[9px] font-medium leading-none',
          isLive
            ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
            : 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400',
        )}
        title={isLive ? 'Live updates connected' : 'Live connection lost — refreshing every 15 seconds instead'}
      >
        <span className="relative flex h-1.5 w-1.5">
          {isLive && (
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-60" />
          )}
          <span
            className={cn(
              'relative inline-flex h-1.5 w-1.5 rounded-full',
              isLive ? 'bg-emerald-500' : 'bg-amber-500 animate-pulse',
            )}
          />
        </span>
        {isLive ? 'Live' : 'Retrying'}
      </span>
    </Button>
  );
}
