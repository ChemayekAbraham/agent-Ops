import { useEffect, useState } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { supabase } from '@/integrations/supabase/client';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { MapPin, User, Home, DoorOpen, Navigation, BedDouble, Banknote, Star } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import TenantRating from '@/components/landlord/TenantRating';
import { toast } from 'sonner';
import { hapticTap } from '@/lib/haptics';

interface Property {
  id: string;
  name: string;
  phone: string;
  property_address: string;
  latitude: number | null;
  longitude: number | null;
  number_of_houses: number | null;
  number_of_rooms: number | null;
  description: string | null;
  monthly_rent: number | null;
  desired_rent_from_welile: number | null;
  tenant_id: string | null;
  verified: boolean | null;
  is_occupied: boolean;
  tenant_name?: string | null;
}

interface MyPropertiesSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId: string;
}

export function MyPropertiesSheet({ open, onOpenChange, userId }: MyPropertiesSheetProps) {
  const [properties, setProperties] = useState<Property[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!open) return;
    const fetch = async () => {
      setLoading(true);
      const { data, error } = await supabase
        .from('landlords')
        .select('id, name, phone, property_address, latitude, longitude, number_of_houses, number_of_rooms, description, monthly_rent, desired_rent_from_welile, tenant_id, verified, is_occupied')
        .eq('registered_by', userId)
        .order('created_at', { ascending: false });

      if (error) {
        console.error(error);
        setLoading(false);
        return;
      }

      // Fetch tenant names for occupied properties
      const withTenants = await Promise.all(
        (data || []).map(async (p) => {
          if (p.tenant_id) {
            const { data: profile } = await supabase
              .from('profiles')
              .select('full_name')
              .eq('id', p.tenant_id)
              .maybeSingle();
            return { ...p, tenant_name: profile?.full_name || null };
          }
          return { ...p, tenant_name: null };
        })
      );

      setProperties(withTenants);
      setLoading(false);
    };
    fetch();
  }, [open, userId]);

  const openInMaps = (lat: number, lng: number) => {
    window.open(`https://www.google.com/maps?q=${lat},${lng}`, '_blank');
  };

  const toggleOccupancy = async (property: Property) => {
    hapticTap();
    const newValue = !property.is_occupied;
    // Optimistic update
    setProperties(prev => prev.map(p => p.id === property.id ? { ...p, is_occupied: newValue } : p));

    const { error } = await supabase
      .from('landlords')
      .update({ is_occupied: newValue } as any)
      .eq('id', property.id);

    if (error) {
      // Revert on error
      setProperties(prev => prev.map(p => p.id === property.id ? { ...p, is_occupied: !newValue } : p));
      toast.error('Failed to update status');
    } else {
      toast.success(newValue ? 'Marked as Occupied' : 'Marked as Empty');
    }
  };

  const occupied = properties.filter(p => p.is_occupied || p.tenant_id);
  const empty = properties.filter(p => !p.is_occupied && !p.tenant_id);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="h-[85vh] rounded-t-3xl flex flex-col pb-safe">
        <SheetHeader className="pb-3 flex-shrink-0">
          <SheetTitle className="flex items-center gap-2 text-lg">
            <Home className="h-5 w-5 text-primary" />
            My Properties ({properties.length})
          </SheetTitle>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto space-y-3 pr-1">
          {loading ? (
            Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-28 w-full rounded-xl" />
            ))
          ) : properties.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <Home className="h-10 w-10 mx-auto mb-2 opacity-30" />
              <p>No properties registered yet</p>
            </div>
          ) : (
            <>
              {/* Summary bar */}
              <div className="flex gap-2 text-xs pb-1">
                <Badge variant="outline" className="bg-success/10 text-success border-success/30">
                  {occupied.length} Occupied
                </Badge>
                <Badge variant="outline" className="bg-warning/10 text-warning border-warning/30">
                  {empty.length} Empty
                </Badge>
              </div>

              {properties.map((p) => {
                const rent = p.desired_rent_from_welile || p.monthly_rent || 0;
                const isOccupied = p.is_occupied || !!p.tenant_id;

                return (
                  <div
                    key={p.id}
                    className="rounded-xl border border-border bg-card p-4 space-y-2.5 shadow-sm"
                  >
                    {/* Header row */}
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <p className="font-semibold text-sm truncate">{p.property_address}</p>
                        <p className="text-xs text-muted-foreground">Owner: {p.name}</p>
                      </div>
                      <Badge
                        variant="outline"
                        className={isOccupied
                          ? 'bg-success/10 text-success border-success/30 text-[10px]'
                          : 'bg-warning/10 text-warning border-warning/30 text-[10px]'
                        }
                      >
                        {isOccupied ? 'Occupied' : 'Empty'}
                      </Badge>
                    </div>

                    {/* Occupancy toggle */}
                    <div className="flex items-center justify-between p-2.5 rounded-lg bg-muted/50 border border-border/50">
                      <div className="flex items-center gap-2">
                        {isOccupied ? (
                          <Home className="h-4 w-4 text-success" />
                        ) : (
                          <DoorOpen className="h-4 w-4 text-warning" />
                        )}
                        <span className="text-xs font-medium">
                          {isOccupied ? 'House is occupied' : 'House is empty'}
                        </span>
                      </div>
                      <Switch
                        checked={isOccupied}
                        onCheckedChange={() => toggleOccupancy(p)}
                        className="data-[state=checked]:bg-success"
                      />
                    </div>

                    {/* Description */}
                    {p.description && (
                      <p className="text-xs text-muted-foreground line-clamp-2">{p.description}</p>
                    )}

                    {/* Details grid */}
                    <div className="grid grid-cols-3 gap-2 text-xs">
                      <div className="flex items-center gap-1.5 text-muted-foreground">
                        <Home className="h-3.5 w-3.5 shrink-0" />
                        <span>{p.number_of_houses || 1} unit{(p.number_of_houses || 1) > 1 ? 's' : ''}</span>
                      </div>
                      <div className="flex items-center gap-1.5 text-muted-foreground">
                        <BedDouble className="h-3.5 w-3.5 shrink-0" />
                        <span>{p.number_of_rooms || '—'} room{(p.number_of_rooms || 0) !== 1 ? 's' : ''}</span>
                      </div>
                      <div className="flex items-center gap-1.5 justify-end">
                        <Banknote className="h-3.5 w-3.5 text-success shrink-0" />
                        <span className="font-semibold text-success">{formatUGX(rent)}</span>
                      </div>
                    </div>

                    {/* Tenant + Rating */}
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5 text-xs">
                        <User className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                        {isOccupied ? (
                          <span className="text-foreground">{p.tenant_name || 'Tenant assigned'}</span>
                        ) : (
                          <span className="text-warning italic">No tenant — awaiting placement</span>
                        )}
                      </div>
                      {isOccupied && p.tenant_id && (
                        <div className="flex items-center gap-1">
                          <span className="text-[10px] text-muted-foreground">Rate:</span>
                          <TenantRating
                            tenantId={p.tenant_id}
                            tenantName={p.tenant_name || 'Tenant'}
                          />
                        </div>
                      )}
                    </div>

                    {/* Rating tip for occupied */}
                    {isOccupied && (
                      <div className="flex items-center gap-1.5 p-2 rounded-lg bg-yellow-500/5 border border-yellow-500/10">
                        <Star className="h-3 w-3 text-yellow-500 shrink-0" />
                        <p className="text-[10px] text-yellow-700 dark:text-yellow-400">
                          Rate your tenant to help them access more credit
                        </p>
                      </div>
                    )}

                    {/* Location */}
                    {p.latitude && p.longitude ? (
                      <button
                        onClick={() => openInMaps(p.latitude!, p.longitude!)}
                        className="flex items-center gap-1.5 text-xs text-primary hover:underline"
                      >
                        <Navigation className="h-3.5 w-3.5" />
                        View on Map
                      </button>
                    ) : (
                      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <MapPin className="h-3.5 w-3.5" />
                        <span>Location not captured</span>
                      </div>
                    )}
                  </div>
                );
              })}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
