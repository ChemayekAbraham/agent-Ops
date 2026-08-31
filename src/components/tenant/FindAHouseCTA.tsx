import { useState, useEffect } from 'react';
import { Sparkles, Home } from 'lucide-react';
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
      className="w-full aspect-square rounded-[28px] border bg-warning/10 border-warning/20 p-2.5 text-left flex flex-col shadow-sm active:scale-[0.99] transition-transform touch-manipulation"
    >
      <div className="flex flex-col justify-between h-full w-full">
        <div>
          <div className="relative w-fit mb-1.5">
            <div className="p-1.5 rounded-xl bg-warning/20">
              <Home className="h-[18px] w-[18px] text-warning" />
            </div>
            {newCount > 0 && (
              <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-warning shadow-sm">
                <span className="absolute inset-0.5 rounded-full bg-warning animate-ping opacity-75" />
                <span className="absolute inset-0.5 rounded-full bg-warning" />
              </span>
            )}
          </div>
          <div className="flex items-center gap-1 flex-wrap">
            <p className="font-bold text-sm leading-tight text-foreground">Find a House Nearby</p>
            {newCount > 0 && (
              <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-warning text-warning-foreground text-[9px] font-semibold uppercase tracking-wider shrink-0">
                <Sparkles className="h-2.5 w-2.5" /> {newCount} new
              </span>
            )}
          </div>
        </div>

        <div className="flex items-end gap-1.5">
          <p className="text-xs text-foreground/70 leading-snug line-clamp-2 break-words">
            {totalCount !== null ? (
              <>{totalCount} available · Pay daily</>
            ) : (
              <>Daily rent · Pay as you stay</>
            )}
          </p>
        </div>



      </div>
    </button>


  );
}
