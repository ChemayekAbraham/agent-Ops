import { useEffect, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Home, MapPin, Sparkles, ChevronRight, Share2 } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { AgentListingsSheet } from '@/components/agent/AgentListingsSheet';
import { hapticTap } from '@/lib/haptics';
import { toast } from 'sonner';
import { ContrastPanel } from '@/components/ui/contrast-panel';

// Solid panel surfaces — text colour auto-derived for guaranteed contrast.
const ROW_BG = 'hsl(22 80% 30%)'; // deep amber/orange, white text auto-picked
const CTA_BG = '#ffffff'; // light CTA, dark text auto-picked

interface EmptyListing {
  id: string;
  title: string;
  address: string;
  region: string;
  monthly_rent: number;
  short_code: string | null;
}

const BOUNTY_AMOUNT = 5000;

/**
 * Highly visible banner shown in the agent wallet:
 * "Earn UGX 5,000 — place a tenant in any of your empty houses."
 * Lists each of the agent's currently-empty listings as a tappable mini-card.
 */
export function EmptyHousePlacementBonusBanner() {
  const { user, role } = useAuth();
  const [listings, setListings] = useState<EmptyListing[]>([]);
  const [loading, setLoading] = useState(true);
  const [openListings, setOpenListings] = useState(false);

  useEffect(() => {
    if (!user?.id || role !== 'agent') {
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from('house_listings')
        .select('id, title, address, region, monthly_rent, short_code, status, tenant_id')
        .eq('agent_id', user.id)
        .eq('status', 'available')
        .is('tenant_id', null)
        .order('created_at', { ascending: false })
        .limit(20);
      if (cancelled) return;
      if (error) {
        console.warn('[EmptyHousePlacementBonusBanner] load failed:', error.message);
        setListings([]);
      } else {
        setListings((data ?? []) as EmptyListing[]);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.id, role]);

  if (role !== 'agent' || loading || listings.length === 0) return null;

  const totalPotential = listings.length * BOUNTY_AMOUNT;

  const shareListing = async (l: EmptyListing) => {
    hapticTap();
    const url = l.short_code
      ? `${window.location.origin}/h/${l.short_code}`
      : `${window.location.origin}/listings/${l.id}`;
    const text = `Empty house available: ${l.title} (${l.region}). UGX ${l.monthly_rent.toLocaleString()}/month. ${url}`;
    try {
      if (navigator.share) {
        await navigator.share({ title: l.title, text, url });
      } else {
        await navigator.clipboard.writeText(text);
        toast.success('Listing link copied — share it to fill the house');
      }
    } catch {
      /* user cancelled */
    }
  };

  return (
    <>
      <Card
        className="border-0 shadow-lg overflow-hidden"
        style={{
          background:
            'linear-gradient(135deg, hsl(45 95% 55%) 0%, hsl(35 95% 50%) 50%, hsl(20 95% 50%) 100%)',
        }}
      >
        <CardContent className="p-4 space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <Sparkles className="h-4 w-4 text-white shrink-0" />
                <Badge className="bg-white/25 text-white border-0 text-[10px] uppercase tracking-wider font-bold">
                  Bounty
                </Badge>
              </div>
              <p className="text-white font-black text-lg leading-tight">
                Earn UGX {BOUNTY_AMOUNT.toLocaleString()} per empty house filled
              </p>
              <p className="text-white/90 text-xs mt-1 leading-snug">
                {listings.length} empty {listings.length === 1 ? 'house' : 'houses'} you listed ·
                up to{' '}
                <span className="font-bold">
                  UGX {totalPotential.toLocaleString()}
                </span>{' '}
                in bounties. Any agent can place the tenant — including you. Bonus auto-credits
                to your withdrawable wallet the moment a tenant is assigned.
              </p>
            </div>
            <div className="h-12 w-12 rounded-2xl bg-white/20 flex items-center justify-center shrink-0">
              <Home className="h-6 w-6 text-white" />
            </div>
          </div>

          <div className="space-y-2">
            {listings.slice(0, 3).map((l) => (
              <ContrastPanel
                key={l.id}
                background={ROW_BG}
                label="empty-house-row"
                className="flex items-center gap-3 hover:opacity-90 active:scale-[0.98] transition-all rounded-xl p-2.5 border border-white/10"
              >
                <div className="h-9 w-9 rounded-lg bg-white/25 flex items-center justify-center shrink-0">
                  <Home className="h-4 w-4 text-white" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-bold text-sm truncate">{l.title}</p>
                  <div className="flex items-center gap-1 text-[11px] opacity-80">
                    <MapPin className="h-3 w-3 shrink-0" />
                    <span className="truncate">{l.address || l.region}</span>
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 px-2 text-white hover:bg-white/30 hover:text-white shrink-0"
                  onClick={(e) => {
                    e.stopPropagation();
                    shareListing(l);
                  }}
                  aria-label="Share listing"
                >
                  <Share2 className="h-4 w-4" />
                </Button>
              </ContrastPanel>
            ))}
          </div>

          <ContrastPanel
            as="button"
            background={CTA_BG}
            largeText
            label="empty-house-cta"
            onClick={() => {
              hapticTap();
              setOpenListings(true);
            }}
            className="w-full inline-flex items-center justify-center h-11 px-5 font-bold rounded-xl hover:opacity-90 active:scale-[0.98] transition-all touch-manipulation"
          >
            View all {listings.length} empty {listings.length === 1 ? 'house' : 'houses'}
            <ChevronRight className="h-4 w-4 ml-1" />
          </ContrastPanel>
        </CardContent>
      </Card>

      <AgentListingsSheet open={openListings} onOpenChange={setOpenListings} />
    </>
  );
}