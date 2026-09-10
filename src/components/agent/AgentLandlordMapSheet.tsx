import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  MapPin, RefreshCw, Building2, Phone, Navigation, CheckCircle2, AlertTriangle, ExternalLink, User
} from 'lucide-react';
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { toast } from 'sonner';
import { formatUGX } from '@/lib/rentCalculations';

// Fix for default marker icons
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
});

const verifiedIcon = new L.Icon({
  iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-green.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
  iconSize: [25, 41], iconAnchor: [12, 41], popupAnchor: [1, -34], shadowSize: [41, 41],
});

const unverifiedIcon = new L.Icon({
  iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-orange.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
  iconSize: [25, 41], iconAnchor: [12, 41], popupAnchor: [1, -34], shadowSize: [41, 41],
});

interface Landlord {
  id: string;
  name: string;
  phone: string;
  property_address: string;
  latitude: number | null;
  longitude: number | null;
  verified: boolean | null;
  number_of_houses: number | null;
  desired_rent_from_welile: number | null;
  has_smartphone: boolean | null;
  mobile_money_name: string | null;
  created_at: string;
}

function FitBounds({ landlords }: { landlords: Landlord[] }) {
  const map = useMap();
  useEffect(() => {
    const valid = landlords.filter(l => l.latitude && l.longitude);
    if (valid.length > 0) {
      const bounds = L.latLngBounds(valid.map(l => [l.latitude!, l.longitude!] as [number, number]));
      map.fitBounds(bounds, { padding: [50, 50] });
    }
  }, [landlords, map]);
  return null;
}

interface AgentLandlordMapSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AgentLandlordMapSheet({ open, onOpenChange }: AgentLandlordMapSheetProps) {
  const { user } = useAuth();
  const [landlords, setLandlords] = useState<Landlord[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<'map' | 'list'>('map');

  const fetchLandlords = async () => {
    if (!user) return;
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('landlords')
        .select('id, name, phone, property_address, latitude, longitude, verified, number_of_houses, desired_rent_from_welile, has_smartphone, mobile_money_name, created_at')
        .eq('registered_by', user.id)
        .order('created_at', { ascending: false });

      if (error) throw error;
      setLandlords(data || []);
    } catch {
      toast.error('Failed to fetch landlords');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open && user) fetchLandlords();
  }, [open, user]);

  const openInGoogleMaps = (lat: number, lng: number) => {
    window.open(`https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`, '_blank');
  };

  const withLocation = landlords.filter(l => l.latitude && l.longitude);
  const withoutLocation = landlords.filter(l => !l.latitude || !l.longitude);
  const defaultCenter: [number, number] = [0.3476, 32.5825];

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="h-[92vh] rounded-t-3xl p-0 flex flex-col">
        <SheetHeader className="px-5 pt-5 pb-3 border-b shrink-0">
          <div className="flex items-center justify-between">
            <div>
              <SheetTitle className="text-lg font-bold flex items-center gap-2">
                <MapPin className="h-5 w-5 text-primary" />
                My Landlords
              </SheetTitle>
              <p className="text-xs text-muted-foreground">{landlords.length} registered · {withLocation.length} on map</p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant={view === 'map' ? 'default' : 'outline'}
                size="sm"
                className="text-xs h-7"
                onClick={() => setView('map')}
              >
                Map
              </Button>
              <Button
                variant={view === 'list' ? 'default' : 'outline'}
                size="sm"
                className="text-xs h-7"
                onClick={() => setView('list')}
              >
                List
              </Button>
              <Button variant="ghost" size="sm" onClick={fetchLandlords} disabled={loading}>
                <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              </Button>
            </div>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-3 gap-2 mt-3">
            <div className="p-2 rounded-lg bg-primary/10 text-center">
              <p className="text-lg font-bold text-primary">{landlords.length}</p>
              <p className="text-[10px] text-muted-foreground">Total</p>
            </div>
            <div className="p-2 rounded-lg bg-success/10 text-center">
              <p className="text-lg font-bold text-success">{landlords.filter(l => l.verified).length}</p>
              <p className="text-[10px] text-muted-foreground">Verified</p>
            </div>
            <div className="p-2 rounded-lg bg-warning/10 text-center">
              <p className="text-lg font-bold text-warning">{landlords.filter(l => !l.verified).length}</p>
              <p className="text-[10px] text-muted-foreground">Pending</p>
            </div>
          </div>
        </SheetHeader>

        {loading ? (
          <div className="p-5 space-y-3">
            <Skeleton className="h-[300px] w-full rounded-lg" />
            <Skeleton className="h-16 w-full rounded-lg" />
          </div>
        ) : view === 'map' ? (
          <div className="flex-1 flex flex-col">
            {withLocation.length === 0 ? (
              <div className="flex-1 flex items-center justify-center p-5">
                <div className="text-center">
                  <Building2 className="h-12 w-12 mx-auto text-muted-foreground/30 mb-2" />
                  <p className="font-semibold text-muted-foreground">No GPS locations yet</p>
                  <p className="text-xs text-muted-foreground mt-1">Capture GPS when registering landlords</p>
                </div>
              </div>
            ) : (
              <>
                <div className="flex-1 min-h-[300px]">
                  <MapContainer
                    center={defaultCenter}
                    zoom={7}
                    style={{ height: '100%', width: '100%' }}
                    scrollWheelZoom={true}
                  >
                    <TileLayer
                      attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
                      url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                    />
                    <FitBounds landlords={withLocation} />
                    {withLocation.map((l) => (
                      <Marker
                        key={l.id}
                        position={[l.latitude!, l.longitude!]}
                        icon={l.verified ? verifiedIcon : unverifiedIcon}
                      >
                        <Popup>
                          <div className="min-w-[220px] p-1">
                            <div className="flex items-center justify-between mb-2">
                              <h3 className="font-semibold text-sm">{l.name}</h3>
                              {l.verified ? (
                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-100 text-green-700">Verified</span>
                              ) : (
                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-orange-100 text-orange-700">Pending</span>
                              )}
                            </div>
                            <div className="space-y-1 text-xs text-muted-foreground">
                              <p className="flex items-center gap-1"><Phone className="h-3 w-3" />{l.phone}</p>
                              <p className="flex items-start gap-1">
                                <MapPin className="h-3 w-3 mt-0.5 shrink-0" />
                                <span className="line-clamp-2">{l.property_address}</span>
                              </p>
                              {l.number_of_houses && (
                                <p className="flex items-center gap-1">
                                  <Building2 className="h-3 w-3" />
                                  {l.number_of_houses} house{l.number_of_houses > 1 ? 's' : ''}
                                </p>
                              )}
                              {l.desired_rent_from_welile && (
                                <p className="font-semibold text-green-600">
                                  Desired: {formatUGX(l.desired_rent_from_welile)}
                                </p>
                              )}
                            </div>
                            <button
                              onClick={() => openInGoogleMaps(l.latitude!, l.longitude!)}
                              className="mt-2 w-full text-xs py-1.5 px-2 bg-blue-500 text-white rounded flex items-center justify-center gap-1 hover:bg-blue-600 transition-colors"
                            >
                              <Navigation className="h-3 w-3" />
                              Navigate in Google Maps
                            </button>
                          </div>
                        </Popup>
                      </Marker>
                    ))}
                  </MapContainer>
                </div>
                {/* Legend */}
                <div className="flex items-center gap-4 px-4 py-2 text-xs text-muted-foreground border-t bg-background">
                  <div className="flex items-center gap-1"><div className="w-3 h-3 rounded-full bg-success" /><span>Verified</span></div>
                  <div className="flex items-center gap-1"><div className="w-3 h-3 rounded-full bg-warning" /><span>Pending</span></div>
                </div>
              </>
            )}
          </div>
        ) : (
          <ScrollArea className="flex-1 px-4 py-3">
            {landlords.length === 0 ? (
              <div className="text-center py-12">
                <Building2 className="h-12 w-12 mx-auto text-muted-foreground/30 mb-2" />
                <p className="font-semibold text-muted-foreground">No landlords registered yet</p>
              </div>
            ) : (
              <div className="space-y-2">
                {landlords.map((l) => (
                  <div key={l.id} className="p-3 rounded-xl border bg-card shadow-sm">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-start gap-3 min-w-0 flex-1">
                        <div className={`h-10 w-10 rounded-full flex items-center justify-center shrink-0 ${l.verified ? 'bg-success/10' : 'bg-warning/10'}`}>
                          {l.verified ? <CheckCircle2 className="h-5 w-5 text-success" /> : <AlertTriangle className="h-5 w-5 text-warning" />}
                        </div>
                        <div className="min-w-0">
                          <p className="font-semibold text-sm truncate">{l.name}</p>
                          <p className="text-xs text-muted-foreground flex items-center gap-1">
                            <Phone className="h-3 w-3" /> {l.phone}
                          </p>
                          <p className="text-xs text-muted-foreground flex items-start gap-1 mt-0.5">
                            <MapPin className="h-3 w-3 mt-0.5 shrink-0" />
                            <span className="line-clamp-1">{l.property_address}</span>
                          </p>
                          {l.mobile_money_name && (
                            <p className="text-[10px] text-muted-foreground mt-0.5">
                              <User className="h-2.5 w-2.5 inline mr-0.5" />MoMo: {l.mobile_money_name}
                            </p>
                          )}
                          <div className="flex items-center gap-2 mt-1 flex-wrap">
                            <Badge variant="outline" className={`text-[10px] ${l.verified ? 'border-success/30 text-success' : 'border-warning/30 text-warning'}`}>
                              {l.verified ? 'Verified' : 'Pending'}
                            </Badge>
                            {l.number_of_houses && (
                              <Badge variant="outline" className="text-[10px]">{l.number_of_houses} house{l.number_of_houses > 1 ? 's' : ''}</Badge>
                            )}
                            {!l.has_smartphone && (
                              <Badge variant="outline" className="text-[10px] border-destructive/30 text-destructive">No Phone</Badge>
                            )}
                          </div>
                        </div>
                      </div>
                      {l.latitude && l.longitude && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="shrink-0 text-xs gap-1 border-primary/30 text-primary"
                          onClick={() => openInGoogleMaps(l.latitude!, l.longitude!)}
                        >
                          <ExternalLink className="h-3 w-3" />
                          Navigate
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </ScrollArea>
        )}
      </SheetContent>
    </Sheet>
  );
}
