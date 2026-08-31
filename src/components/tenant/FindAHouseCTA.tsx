import { useState, useEffect } from 'react';
import { Sparkles, ChevronRight, Home } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';

interface FindAHouseCTAProps {
  onClick: () => void;
}

export function FindAHouseCTA({ onClick }: FindAHouseCTAProps) {
  const [totalCount, setTotalCount] = useState<number | null>(null);
  const [newCount, setNewCount] = useState<number>(0);

  useEffect(() => {
    async function fetchCounts() {
      const [totalRes, newRes] = await Promise.all([
        supabase
          .from('house_listings')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'available')
          .eq('is_hidden', false)
          .eq('verified', true)
          .is('tenant_id', null),
        supabase
          .from('house_listings')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'available')
          .eq('is_hidden', false)
          .eq('verified', true)
          .is('tenant_id', null)
          .gte('created_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()),
      ]);
      if (totalRes.count !== null) setTotalCount(totalRes.count);
      if (newRes.count !== null) setNewCount(newRes.count);
    }
    fetchCounts();

    // Subscribe to new listings for real-time count updates
    const channel = supabase
      .channel('house_listings_count')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'house_listings' }, () => {
        fetchCounts();
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, []);

  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full rounded-[28px] border bg-card p-4 text-left flex items-center gap-3 shadow-sm active:scale-[0.99] transition-transform touch-manipulation"
    >
      <div className="relative shrink-0">
        <div className="p-2.5 rounded-2xl bg-primary/10">
          <Home className="h-6 w-6 text-primary" />
        </div>
        {newCount > 0 && (
          <span className="absolute -top-1 -right-1 w-3 h-3 rounded-full bg-destructive shadow-sm">
            <span className="absolute inset-1 rounded-full bg-destructive animate-ping opacity-75" />
            <span className="absolute inset-1 rounded-full bg-destructive" />
          </span>
        )}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <p className="font-bold text-base leading-tight truncate">Find a House Nearby</p>
          {newCount > 0 && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-primary/10 text-[10px] font-semibold uppercase tracking-wider shrink-0">
              <Sparkles className="h-3 w-3" /> {newCount} new
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground leading-snug truncate">
          {totalCount !== null ? (
            <>{totalCount} house{totalCount !== 1 ? 's' : ''} available · Pay daily</>
          ) : (
            <>Daily rent · Pay as you stay</>
          )}
        </p>
      </div>

      <ChevronRight className="h-5 w-5 text-muted-foreground shrink-0" />
    </button>
  );
}
