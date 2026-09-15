import { FileText } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
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

  const { data: promissoryPending = 0 } = useQuery({
    queryKey: ['promissory-notes-pending-count'],
    queryFn: async () => {
      const { count } = await supabase
        .from('promissory_notes')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'pending');
      return count || 0;
    },
    staleTime: 30000,
  });

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
