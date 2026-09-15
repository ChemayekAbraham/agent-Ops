import { useEffect } from 'react';
import { FileText } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
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

  const { data: promissoryPending = 0, refetch } = useQuery({
    queryKey: ['promissory-notes-pending-count'],
    queryFn: async () => {
      const { count } = await supabase
        .from('promissory_notes')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'pending');
      return count || 0;
    },
    staleTime: 30000,
    // Live-feed fallback: the promissory_notes table is not in the realtime
    // publication, so poll every 15s until realtime events are available.
    refetchInterval: 15000,
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
          queryClient.invalidateQueries({ queryKey: ['promissory-notes-pending-count'] });
        },
      )
      .subscribe();
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
    </Button>
  );
}
