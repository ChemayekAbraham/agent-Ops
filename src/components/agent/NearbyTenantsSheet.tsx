import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Sheet, SheetContent, SheetHeader, SheetTitle,
} from '@/components/ui/sheet';
import { MapPin, Navigation, Loader2, Users, Locate, Phone, Home } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { motion } from 'framer-motion';
import { hapticTap } from '@/lib/haptics';
import { toast } from 'sonner';

interface NearbyTenant {
  id: string;
  full_name: string;
  phone: string;
  city: string | null;
  landlord_name: string;
  landlord_phone: string;
  landlord_address: string;
  landlord_latitude: number | null;
  landlord_longitude: number | null;
  rent_amount: number;
  distance_km: number;
  request_id: string;
  verified: boolean;
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

interface NearbyTenantsSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function NearbyTenantsSheet({ open, onOpenChange }: NearbyTenantsSheetProps) {
  const { user } = useAuth();
  const [loading, setLoading] = useState(false);
  const [locating, setLocating] = useState(false);
  const [agentPos, setAgentPos] = useState<{ lat: number; lng: number } | null>(null);
  const [tenants, setTenants] = useState<NearbyTenant[]>([]);
  const MAX_DISTANCE_KM = 20;

  const captureLocation = useCallback(() => {
    if (!navigator.geolocation) {
      toast.error('GPS not supported on this device');
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setAgentPos({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setLocating(false);
        toast.success('Location captured!');
      },
      () => {
        setLocating(false);
        toast.error('Please allow location access');
      },
      { enableHighAccuracy: true, timeout: 15000 }
    );
  }, []);

  const fetchNearbyTenants = useCallback(async () => {
    if (!agentPos) return;
    setLoading(true);
    try {
      // Fetch unverified rent requests with tenant & landlord info
      const { data: requests } = await (supabase
        .from('rent_requests') as any)
        .select(`
          id, rent_amount, agent_verified,
          tenant:profiles!rent_requests_tenant_id_fkey(id, full_name, phone, city),
          landlord:landlords!rent_requests_landlord_id_fkey(name, phone, property_address, latitude, longitude, verified)
        `)
        .in('status', ['pending', 'approved'])
        .order('created_at', { ascending: false })
        .limit(200);

      if (!requests) { setLoading(false); return; }

      const nearby: NearbyTenant[] = [];
      for (const req of requests as any[]) {
        const ll = req.landlord;
        const t = req.tenant;
        if (!ll || !t) continue;

        // Use landlord GPS if available, otherwise skip (can't compute distance)
        if (ll.latitude && ll.longitude) {
          const dist = haversineKm(agentPos.lat, agentPos.lng, ll.latitude, ll.longitude);
          if (dist <= MAX_DISTANCE_KM) {
            nearby.push({
              id: t.id,
              full_name: t.full_name || 'Unknown',
              phone: t.phone || '',
              city: t.city,
              landlord_name: ll.name,
              landlord_phone: ll.phone || '',
              landlord_address: ll.property_address,
              landlord_latitude: ll.latitude,
              landlord_longitude: ll.longitude,
              rent_amount: req.rent_amount,
              distance_km: dist,
              request_id: req.id,
              verified: !!ll.verified,
            });
          }
        }
      }

      nearby.sort((a, b) => a.distance_km - b.distance_km);
      setTenants(nearby);
    } catch (err) {
      console.error('Nearby tenants fetch error:', err);
    }
    setLoading(false);
  }, [agentPos]);

  useEffect(() => {
    if (open && !agentPos) captureLocation();
  }, [open]);

  useEffect(() => {
    if (agentPos) fetchNearbyTenants();
  }, [agentPos, fetchNearbyTenants]);

  const navigateToLandlord = (t: NearbyTenant) => {
    hapticTap();
    const dest = t.landlord_latitude && t.landlord_longitude
      ? `${t.landlord_latitude},${t.landlord_longitude}`
      : encodeURIComponent(`${t.landlord_address}, Uganda`);
    window.open(`https://www.google.com/maps/dir/?api=1&destination=${dest}`, '_blank');
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="h-[90vh] rounded-t-2xl p-0">
        <SheetHeader className="p-4 pb-2">
          <SheetTitle className="flex items-center gap-2">
            <MapPin className="h-5 w-5 text-primary" />
            Nearby Tenants & Landlords
          </SheetTitle>
          <p className="text-sm text-muted-foreground">
            Visit landlords near you to verify tenants and earn <span className="font-bold text-success">UGX 10,000</span>
          </p>
        </SheetHeader>

        {/* Location status */}
        <div className="px-4 pb-2">
          <div className="flex items-center gap-2 p-2.5 rounded-lg bg-muted/50 border border-border/60">
            {agentPos ? (
              <>
                <div className="h-2 w-2 rounded-full bg-success animate-pulse" />
                <span className="text-xs text-muted-foreground flex-1">
                  GPS active · Showing within {MAX_DISTANCE_KM}km
                </span>
                <Button variant="ghost" size="sm" className="h-7 text-xs gap-1" onClick={captureLocation} disabled={locating}>
                  <Locate className="h-3 w-3" />
                  Refresh
                </Button>
              </>
            ) : (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                <span className="text-xs text-muted-foreground flex-1">
                  {locating ? 'Getting your location...' : 'Location needed'}
                </span>
                {!locating && (
                  <Button variant="default" size="sm" className="h-7 text-xs gap-1" onClick={captureLocation}>
                    <Locate className="h-3 w-3" />
                    Enable GPS
                  </Button>
                )}
              </>
            )}
          </div>
        </div>

        <ScrollArea className="h-[calc(90vh-180px)] px-4 pb-4">
          {loading ? (
            <div className="space-y-3">
              {[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-32 w-full rounded-xl" />)}
            </div>
          ) : tenants.length === 0 ? (
            <div className="text-center py-12 space-y-3">
              <Users className="h-10 w-10 text-muted-foreground mx-auto" />
              <p className="font-semibold text-foreground">No nearby tenants found</p>
              <p className="text-sm text-muted-foreground">
                {agentPos ? `No tenants with landlords within ${MAX_DISTANCE_KM}km` : 'Enable GPS to find nearby tenants'}
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center justify-between px-1">
                <p className="text-xs text-muted-foreground font-medium">
                  {tenants.length} tenant{tenants.length !== 1 ? 's' : ''} nearby
                </p>
                <Badge variant="outline" className="text-[10px] bg-primary/10 text-primary border-primary/30">
                  Sorted by distance
                </Badge>
              </div>

              {tenants.map((t, i) => (
                <motion.div
                  key={t.request_id}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.05 }}
                >
                  <Card className="border-border/60 overflow-hidden">
                    <CardContent className="p-0">
                      {/* Distance banner */}
                      <div className="flex items-center gap-1.5 px-3 py-1.5 bg-primary/5 border-b border-border/40">
                        <MapPin className="h-3 w-3 text-primary" />
                        <span className="text-[11px] font-bold text-primary">
                          {t.distance_km < 1 ? `${Math.round(t.distance_km * 1000)}m away` : `${t.distance_km.toFixed(1)}km away`}
                        </span>
                        {!t.verified && (
                          <Badge variant="outline" className="ml-auto text-[9px] px-1.5 py-0 bg-amber-500/10 text-amber-600 border-amber-500/30">
                            Unverified Landlord
                          </Badge>
                        )}
                        {t.verified && (
                          <Badge variant="outline" className="ml-auto text-[9px] px-1.5 py-0 bg-success/10 text-success border-success/30">
                            Verified
                          </Badge>
                        )}
                      </div>

                      <div className="p-3 space-y-2.5">
                        {/* Tenant info */}
                        <div className="flex items-start justify-between">
                          <div>
                            <p className="font-semibold text-sm">{t.full_name}</p>
                            <p className="text-xs text-muted-foreground">{t.city || 'No city'}</p>
                          </div>
                          <p className="font-bold text-primary text-sm">{formatUGX(t.rent_amount)}</p>
                        </div>

                        {/* Landlord info */}
                        <div className="p-2.5 rounded-lg bg-muted/40 space-y-1">
                          <div className="flex items-center gap-1.5">
                            <Home className="h-3 w-3 text-muted-foreground" />
                            <p className="text-xs font-semibold">{t.landlord_name}</p>
                          </div>
                          <p className="text-[11px] text-muted-foreground pl-[18px]">{t.landlord_address}</p>
                          {t.landlord_phone && (
                            <a href={`tel:${t.landlord_phone}`} className="flex items-center gap-1.5 pl-[18px] text-[11px] text-primary">
                              <Phone className="h-3 w-3" />
                              {t.landlord_phone}
                            </a>
                          )}
                        </div>

                        {/* Actions */}
                        <div className="flex items-center gap-2">
                          <Button
                            onClick={() => navigateToLandlord(t)}
                            variant="default"
                            size="sm"
                            className="flex-1 gap-1.5 text-xs h-9"
                          >
                            <Navigation className="h-3.5 w-3.5" />
                            Navigate to Landlord
                          </Button>
                          {t.landlord_phone && (
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-9 w-9 p-0"
                              onClick={() => window.open(`tel:${t.landlord_phone}`)}
                            >
                              <Phone className="h-3.5 w-3.5" />
                            </Button>
                          )}
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                </motion.div>
              ))}
            </div>
          )}
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
