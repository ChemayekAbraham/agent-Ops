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
      className="w-full aspect-square rounded-[28px] border bg-warning/10 border-warning/20 p-4 text-left flex flex-col shadow-sm active:scale-[0.99] transition-transform touch-manipulation"
    >
      <div className="flex flex-col justify-between h-full w-full">
        <div>
          <div className="relative w-fit mb-3">
            <div className="p-2.5 rounded-2xl bg-warning/20">
              <Home className="h-6 w-6 text-warning" />
            </div>
            {newCount > 0 && (
              <span className="absolute -top-1 -right-1 w-3 h-3 rounded-full bg-warning shadow-sm">
                <span className="absolute inset-1 rounded-full bg-warning animate-ping opacity-75" />
                <span className="absolute inset-1 rounded-full bg-warning" />
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            <p className="font-bold text-lg leading-tight text-foreground">Find a House Nearby</p>
            {newCount > 0 && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-warning text-warning-foreground text-[10px] font-semibold uppercase tracking-wider shrink-0">
                <Sparkles className="h-3 w-3" /> {newCount} new
              </span>
            )}
          </div>
        </div>

        <div className="flex items-end justify-between gap-2">
          <p className="text-xs text-foreground/70 leading-snug truncate">
            {totalCount !== null ? (
              <>{totalCount} available · Pay daily</>
            ) : (
              <>Daily rent · Pay as you stay</>
            )}
          </p>
          <ChevronRight className="h-5 w-5 text-warning shrink-0" />
        </div>
      </div>
    </button>
  );
}
