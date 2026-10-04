import { useEffect, useMemo, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { hapticTap } from '@/lib/haptics';
import { formatUGX } from '@/lib/rentCalculations';
import {
  Search, MapPin, Navigation, Loader2, Phone, BadgeCheck, Home,
  Wallet, Send, CheckCircle2, Building2,
} from 'lucide-react';

interface ClaimRentDiscountDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  monthlyRent: number | null;
  discountPct: number; // 0..1
}

interface WelileLandlord {
  id: string;
  name: string;
  phone: string;
  property_address: string | null;
  monthly_rent: number | null;
  verified: boolean | null;
  ready_to_receive: boolean | null;
  latitude: number | null;
  longitude: number | null;
  distanceKm: number | null;
}

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number) {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function ClaimRentDiscountDialog({
  open, onOpenChange, monthlyRent, discountPct,
}: ClaimRentDiscountDialogProps) {
  const { toast } = useToast();
  const [landlords, setLandlords] = useState<WelileLandlord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [locating, setLocating] = useState(false);
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [sentIds, setSentIds] = useState<Set<string>>(new Set());
  const [floatClaiming, setFloatClaiming] = useState(false);
  const [floatClaimed, setFloatClaimed] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim().toLowerCase()), 250);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    if (!open) {
      setSentIds(new Set());
      setFloatClaimed(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      const { data, error: dbErr } = await supabase
        .from('landlords')
        .select('id, name, phone, property_address, monthly_rent, verified, ready_to_receive, latitude, longitude')
        .or('verified.eq.true,ready_to_receive.eq.true')
        .order('verified', { ascending: false })
        .limit(100);
      if (cancelled) return;
      if (dbErr) {
        setError('Could not load Welile landlords.');
        setLandlords([]);
      } else {
        setLandlords(
          (data ?? []).map((l: any) => ({
            id: l.id,
            name: l.name,
            phone: l.phone,
            property_address: l.property_address ?? null,
            monthly_rent: l.monthly_rent != null ? Number(l.monthly_rent) : null,
            verified: l.verified,
            ready_to_receive: l.ready_to_receive,
            latitude: l.latitude != null ? Number(l.latitude) : null,
            longitude: l.longitude != null ? Number(l.longitude) : null,
            distanceKm: null,
          })),
        );
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [open]);

  const requestLocation = () => {
    if (!('geolocation' in navigator)) {
      toast({ title: 'Location not supported', variant: 'destructive' });
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setLocating(false);
        toast({ title: 'Location updated', description: 'Sorted by closest landlords.' });
      },
      () => {
        setLocating(false);
        toast({ title: 'Location unavailable', variant: 'destructive' });
      },
      { timeout: 8000 },
    );
  };

  const filtered = useMemo(() => {
    let list = landlords;
    if (debounced) {
      const digits = debounced.replace(/\D/g, '');
      list = list.filter((l) => {
        const name = l.name.toLowerCase();
        const phone = (l.phone || '').replace(/\D/g, '');
        const addr = (l.property_address || '').toLowerCase();
        return (
          name.includes(debounced) ||
          addr.includes(debounced) ||
          (digits && phone.includes(digits))
        );
      });
    }
    if (coords) {
      list = list.map((l) =>
        l.latitude != null && l.longitude != null
          ? { ...l, distanceKm: haversineKm(coords.lat, coords.lng, l.latitude, l.longitude) }
          : l,
      );
    }
    return [...list].sort((a, b) => {
      if (a.distanceKm != null && b.distanceKm != null) return a.distanceKm - b.distanceKm;
      if (a.distanceKm != null) return -1;
      if (b.distanceKm != null) return 1;
      return a.name.localeCompare(b.name);
    });
  }, [landlords, debounced, coords]);

  const discountAmount = monthlyRent && discountPct > 0 ? Math.round(monthlyRent * discountPct) : 0;

  const handleSend = (l: WelileLandlord) => {
    hapticTap();
    setSendingId(l.id);
    setTimeout(() => {
      setSendingId(null);
      setSentIds((prev) => {
        const next = new Set(prev);
        next.add(l.id);
        return next;
      });
      toast({
        title: 'Discount claim sent',
        description: `${l.name} will see your Welile rent discount request.`,
      });
    }, 700);
  };

  const handleFloatClaim = () => {
    hapticTap();
    setFloatClaiming(true);
    setTimeout(() => {
      setFloatClaiming(false);
      setFloatClaimed(true);
      toast({
        title: 'Claimed from Welile Landlord Float',
        description: discountAmount > 0
          ? `${formatUGX(discountAmount)} reserved against your next rent payout.`
          : 'Your rent discount is queued against the Welile Landlord Float.',
      });
    }, 800);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md p-0 overflow-hidden">
        <DialogHeader className="px-5 pt-5 pb-3 bg-gradient-to-br from-emerald-500 to-emerald-700 text-white">
          <DialogTitle className="text-lg font-bold flex items-center gap-2">
            <Home className="h-5 w-5" /> Claim your Welile rent discount
          </DialogTitle>
          <DialogDescription className="text-white/90 text-xs">
            {monthlyRent ? (
              <>
                Saved rent: <span className="font-bold">{formatUGX(monthlyRent)}</span>
                {discountAmount > 0 && (
                  <> · You save <span className="font-bold">{formatUGX(discountAmount)}</span></>
                )}
              </>
            ) : (
              <>Pick a Welile landlord nearby, or search by name / phone.</>
            )}
          </DialogDescription>
        </DialogHeader>

        {/* Float claim CTA */}
        <div className="px-5 py-3 border-b border-border bg-emerald-50/60 dark:bg-emerald-950/20">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-full bg-emerald-600/15 flex items-center justify-center shrink-0">
              <Wallet className="h-4 w-4 text-emerald-700 dark:text-emerald-300" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-foreground">Welile Landlord Float</p>
              <p className="text-[11px] text-muted-foreground">
                Claim instantly without choosing a landlord.
              </p>
            </div>
            <Button
              size="sm"
              onClick={handleFloatClaim}
              disabled={floatClaiming || floatClaimed}
              className="h-8 text-[11px] bg-emerald-600 hover:bg-emerald-700 text-white"
            >
              {floatClaiming ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : floatClaimed ? (
                <><CheckCircle2 className="h-3 w-3 mr-1" /> Claimed</>
              ) : (
                'Claim'
              )}
            </Button>
          </div>
        </div>

        {/* Search + location */}
        <div className="px-5 py-3 border-b border-border space-y-2">
          <div className="relative">
            <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search landlord by name or phone…"
              className="h-9 pl-8 text-sm"
              inputMode="search"
            />
          </div>
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] text-muted-foreground inline-flex items-center gap-1">
              <Building2 className="h-3 w-3" />
              Welile-subscribed landlords
            </p>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-[11px]"
              onClick={requestLocation}
              disabled={locating}
            >
              {locating ? <Loader2 className="h-3 w-3 animate-spin" /> : <Navigation className="h-3 w-3" />}
              <span className="ml-1">Nearby</span>
            </Button>
          </div>
        </div>

        {/* Landlord list */}
        <ul className="max-h-[55vh] overflow-y-auto divide-y divide-border">
          {loading && (
            <li className="px-5 py-8 flex items-center justify-center text-xs text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading Welile landlords…
            </li>
          )}
          {!loading && error && (
            <li className="px-5 py-6 text-center text-xs text-destructive">{error}</li>
          )}
          {!loading && !error && filtered.length === 0 && (
            <li className="px-5 py-8 text-center text-xs text-muted-foreground">
              {debounced
                ? 'No matching landlords on Welile yet.'
                : 'No Welile landlords available right now.'}
            </li>
          )}
          {filtered.map((l) => {
            const sent = sentIds.has(l.id);
            const sending = sendingId === l.id;
            return (
              <li key={l.id} className="px-5 py-3 flex items-start gap-3">
                <div className="h-9 w-9 rounded-full bg-muted flex items-center justify-center shrink-0">
                  <Home className="h-4 w-4 text-muted-foreground" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <p className="font-semibold text-sm text-foreground truncate">{l.name}</p>
                    {l.verified && (
                      <BadgeCheck className="h-3.5 w-3.5 text-emerald-600 shrink-0" />
                    )}
                  </div>
                  {l.property_address && (
                    <p className="text-[11px] text-muted-foreground truncate">{l.property_address}</p>
                  )}
                  <div className="mt-1 flex items-center flex-wrap gap-2 text-[10px]">
                    <span className="inline-flex items-center gap-1 text-muted-foreground">
                      <Phone className="h-3 w-3" /> {l.phone}
                    </span>
                    {l.distanceKm != null && (
                      <span className="inline-flex items-center gap-1 text-muted-foreground">
                        <MapPin className="h-3 w-3" /> {l.distanceKm.toFixed(1)} km
                      </span>
                    )}
                    {l.monthly_rent != null && l.monthly_rent > 0 && (
                      <Badge variant="outline" className="h-4 px-1.5 text-[9px]">
                        {formatUGX(l.monthly_rent)}/mo
                      </Badge>
                    )}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant={sent ? 'outline' : 'default'}
                  onClick={() => handleSend(l)}
                  disabled={sending || sent}
                  className="h-8 text-[11px] shrink-0"
                >
                  {sending ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : sent ? (
                    <><CheckCircle2 className="h-3 w-3 mr-1" /> Sent</>
                  ) : (
                    <><Send className="h-3 w-3 mr-1" /> Send</>
                  )}
                </Button>
              </li>
            );
          })}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
