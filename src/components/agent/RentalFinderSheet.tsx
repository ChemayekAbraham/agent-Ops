import { useState, useEffect, useMemo, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { supabase } from '@/integrations/supabase/client';
import {
  Search,
  MapPin,
  ChevronRight,
  ChevronLeft,
  Navigation,
  Phone,
  Home,
  User,
  Building2,
  Globe,
  Map,
  Loader2,
  X,
  Zap,
  Droplets,
  BadgeCheck,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { hapticTap } from '@/lib/haptics';

interface RentalFinderSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface Landlord {
  id: string;
  name: string;
  phone: string;
  property_address: string;
  latitude: number | null;
  longitude: number | null;
  monthly_rent: number | null;
  number_of_rooms: number | null;
  number_of_houses: number | null;
  verified: boolean | null;
  country: string | null;
  region: string | null;
  district: string | null;
  county: string | null;
  sub_county: string | null;
  town_council: string | null;
  village: string | null;
  cell: string | null;
  house_number: string | null;
  electricity_meter_number: string | null;
  water_meter_number: string | null;
  caretaker_name: string | null;
  caretaker_phone: string | null;
}

type LocationLevel = 'country' | 'region' | 'district' | 'county' | 'sub_county' | 'town_council' | 'village' | 'cell' | 'house';

const LEVEL_CONFIG: { key: LocationLevel; label: string; icon: typeof Globe; dbField: string }[] = [
  { key: 'country', label: 'Country', icon: Globe, dbField: 'country' },
  { key: 'region', label: 'Region', icon: Map, dbField: 'region' },
  { key: 'district', label: 'District', icon: Building2, dbField: 'district' },
  { key: 'county', label: 'County', icon: MapPin, dbField: 'county' },
  { key: 'sub_county', label: 'Sub-County', icon: MapPin, dbField: 'sub_county' },
  { key: 'town_council', label: 'Town Council', icon: Building2, dbField: 'town_council' },
  { key: 'village', label: 'Village', icon: Home, dbField: 'village' },
  { key: 'cell', label: 'Cell', icon: MapPin, dbField: 'cell' },
  { key: 'house', label: 'House', icon: Home, dbField: 'house_number' },
];

export function RentalFinderSheet({ open, onOpenChange }: RentalFinderSheetProps) {
  const [landlords, setLandlords] = useState<Landlord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [currentLevel, setCurrentLevel] = useState(0);
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [selectedLandlord, setSelectedLandlord] = useState<Landlord | null>(null);

  const fetchLandlords = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: fetchError } = await supabase
      .from('landlords_directory')
      .select('id, name, phone, property_address, latitude, longitude, monthly_rent, number_of_rooms, number_of_houses, verified, country, region, district, county, sub_county, town_council, village, cell, house_number, electricity_meter_number, water_meter_number, caretaker_name, caretaker_phone')
      .order('created_at', { ascending: false })
      .limit(2000);
    if (fetchError) {
      console.error('[RentalFinderSheet] landlord fetch failed:', fetchError);
      setError('Could not load landlords. Pull to retry.');
      setLandlords([]);
    } else {
      setLandlords((data as Landlord[]) || []);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (open) {
      fetchLandlords();
      setCurrentLevel(0);
      setFilters({});
      setSelectedLandlord(null);
      setSearch('');
    }
  }, [open, fetchLandlords]);

  // Get filtered landlords based on current drill-down
  const filteredLandlords = useMemo(() => {
    let result = landlords;
    Object.entries(filters).forEach(([field, value]) => {
      result = result.filter(l => (l as any)[field] === value);
    });
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(l =>
        l.name.toLowerCase().includes(q) ||
        l.property_address.toLowerCase().includes(q) ||
        l.phone.includes(q) ||
        (l.village || '').toLowerCase().includes(q) ||
        (l.district || '').toLowerCase().includes(q)
      );
    }
    return result;
  }, [landlords, filters, search]);

  // Get unique values for current drill-down level
  const currentConfig = LEVEL_CONFIG[currentLevel];
  const uniqueValues = useMemo(() => {
    if (!currentConfig) return [];
    const field = currentConfig.dbField as keyof Landlord;
    const values = filteredLandlords
      .map(l => l[field] as string | null)
      .filter((v): v is string => !!v && v.trim() !== '');
    const unique = [...new Set(values)].sort();
    return unique.map(val => ({
      value: val,
      count: filteredLandlords.filter(l => (l as any)[currentConfig.dbField] === val).length,
    }));
  }, [filteredLandlords, currentConfig]);

  const handleDrillDown = (value: string) => {
    hapticTap();
    setFilters(prev => ({ ...prev, [currentConfig.dbField]: value }));
    setCurrentLevel(prev => prev + 1);
  };

  const handleBack = () => {
    hapticTap();
    if (selectedLandlord) {
      setSelectedLandlord(null);
      return;
    }
    if (currentLevel > 0) {
      const prevConfig = LEVEL_CONFIG[currentLevel - 1];
      setFilters(prev => {
        const next = { ...prev };
        delete next[prevConfig.dbField];
        return next;
      });
      setCurrentLevel(prev => prev - 1);
    }
  };

  const handleNavigate = (lat: number, lng: number) => {
    window.open(`https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`, '_blank');
  };

  const handleCall = (phone: string) => {
    window.open(`tel:${phone}`);
  };

  // Breadcrumb path
  const breadcrumb = Object.entries(filters).map(([field, value]) => {
    const config = LEVEL_CONFIG.find(c => c.dbField === field);
    return { label: config?.label || field, value };
  });

  // If we've drilled past all levels or no more unique values, show property list
  const showProperties = currentLevel >= LEVEL_CONFIG.length || (uniqueValues.length === 0 && currentLevel > 0);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="h-[95vh] rounded-t-3xl p-0 flex flex-col">
        {/* Header */}
        <SheetHeader className="p-4 pb-2 border-b border-border">
          <div className="flex items-center gap-2">
            {(currentLevel > 0 || selectedLandlord) && (
              <Button variant="ghost" size="icon" onClick={handleBack} className="shrink-0">
                <ChevronLeft className="h-5 w-5" />
              </Button>
            )}
            <div className="flex-1">
              <SheetTitle className="text-left">
                {selectedLandlord ? 'Rental Details' : 'Find Rentals'}
              </SheetTitle>
              {!selectedLandlord && (
                <p className="text-xs text-muted-foreground">
                  {showProperties
                    ? `${filteredLandlords.length} properties found`
                    : `Browse by ${currentConfig?.label || 'location'}`}
                </p>
              )}
            </div>
            <Badge variant="secondary" className="text-xs">
              {landlords.length} total
            </Badge>
          </div>

          {/* Breadcrumb */}
          {breadcrumb.length > 0 && !selectedLandlord && (
            <div className="flex flex-wrap gap-1 mt-2">
              {breadcrumb.map((b, i) => (
                <Badge key={i} variant="outline" className="text-[10px] gap-1">
                  <span className="text-muted-foreground">{b.label}:</span> {b.value}
                </Badge>
              ))}
            </div>
          )}

          {/* Search */}
          {!selectedLandlord && (
            <div className="relative mt-2">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search name, address, phone..."
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="pl-9 pr-8 h-10 rounded-xl"
              />
              {search && (
                <button onClick={() => setSearch('')} className="absolute right-3 top-1/2 -translate-y-1/2">
                  <X className="h-4 w-4 text-muted-foreground" />
                </button>
              )}
            </div>
          )}
        </SheetHeader>

        {/* Content */}
        <ScrollArea className="flex-1">
          {loading ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : error ? (
            <div className="text-center py-20 text-muted-foreground px-4">
              <Home className="h-8 w-8 mx-auto mb-2 opacity-40" />
              <p className="text-sm">{error}</p>
              <Button variant="outline" size="sm" className="mt-3" onClick={() => fetchLandlords()}>
                Try again
              </Button>
            </div>
          ) : selectedLandlord ? (
            <LandlordDetail landlord={selectedLandlord} onNavigate={handleNavigate} onCall={handleCall} />
          ) : showProperties ? (
            <PropertyList
              landlords={filteredLandlords}
              onSelect={l => { hapticTap(); setSelectedLandlord(l); }}
            />
          ) : (
            <LocationDrillDown
              level={currentConfig}
              values={uniqueValues}
              onSelect={handleDrillDown}
              onViewAll={() => setCurrentLevel(LEVEL_CONFIG.length)}
              totalCount={filteredLandlords.length}
            />
          )}
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}

/* ── Location drill-down list ── */
function LocationDrillDown({
  level,
  values,
  onSelect,
  onViewAll,
  totalCount,
}: {
  level: typeof LEVEL_CONFIG[0];
  values: { value: string; count: number }[];
  onSelect: (v: string) => void;
  onViewAll: () => void;
  totalCount: number;
}) {
  const Icon = level.icon;
  return (
    <div className="p-4 space-y-2">
      {/* View All button */}
      <motion.button
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        onClick={onViewAll}
        className="w-full flex items-center gap-3 p-4 rounded-xl bg-primary/5 border border-primary/20 hover:bg-primary/10 transition-all text-left"
      >
        <div className="p-2 rounded-lg bg-primary/10">
          <MapPin className="h-5 w-5 text-primary" />
        </div>
        <div className="flex-1">
          <p className="font-medium text-sm">View All Properties</p>
          <p className="text-xs text-muted-foreground">{totalCount} rentals</p>
        </div>
        <ChevronRight className="h-4 w-4 text-muted-foreground" />
      </motion.button>

      <Separator className="my-3" />

      {values.length === 0 ? (
        <div className="text-center py-10 text-muted-foreground">
          <Icon className="h-8 w-8 mx-auto mb-2 opacity-40" />
          <p className="text-sm">No {level.label.toLowerCase()} data available yet</p>
          <p className="text-xs mt-1">Properties will appear here once location details are added</p>
        </div>
      ) : (
        values.map((item, i) => (
          <motion.button
            key={item.value}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.03 }}
            onClick={() => onSelect(item.value)}
            className="w-full flex items-center gap-3 p-3 rounded-xl hover:bg-muted/50 active:scale-[0.98] transition-all text-left"
          >
            <div className="p-2 rounded-lg bg-muted">
              <Icon className="h-5 w-5 text-foreground" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-medium text-sm truncate">{item.value}</p>
            </div>
            <Badge variant="secondary" className="text-xs shrink-0">{item.count}</Badge>
            <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
          </motion.button>
        ))
      )}
    </div>
  );
}

/* ── Property list ── */
function PropertyList({
  landlords,
  onSelect,
}: {
  landlords: Landlord[];
  onSelect: (l: Landlord) => void;
}) {
  if (landlords.length === 0) {
    return (
      <div className="text-center py-20 text-muted-foreground">
        <Home className="h-8 w-8 mx-auto mb-2 opacity-40" />
        <p className="text-sm">No rentals found</p>
      </div>
    );
  }

  return (
    <div className="p-4 space-y-2">
      {landlords.map((l, i) => (
        <motion.button
          key={l.id}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: i * 0.02 }}
          onClick={() => onSelect(l)}
          className="w-full flex items-center gap-3 p-3 rounded-xl hover:bg-muted/50 active:scale-[0.98] transition-all text-left border border-border/50"
        >
          <div className={cn(
            "p-2 rounded-lg",
            l.verified ? "bg-success/10" : "bg-warning/10"
          )}>
            <Home className={cn("h-5 w-5", l.verified ? "text-success" : "text-warning")} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              <p className="font-medium text-sm truncate">{l.name}</p>
              {l.verified && <BadgeCheck className="h-3.5 w-3.5 text-success shrink-0" />}
            </div>
            <p className="text-xs text-muted-foreground truncate">{l.property_address}</p>
            {l.village && (
              <p className="text-[10px] text-muted-foreground truncate">
                {[l.village, l.cell, l.district].filter(Boolean).join(' · ')}
              </p>
            )}
          </div>
          {l.number_of_rooms && (
            <Badge variant="outline" className="text-[10px] shrink-0">{l.number_of_rooms} rooms</Badge>
          )}
          <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
        </motion.button>
      ))}
    </div>
  );
}

/* ── Landlord detail card ── */
function LandlordDetail({
  landlord,
  onNavigate,
  onCall,
}: {
  landlord: Landlord;
  onNavigate: (lat: number, lng: number) => void;
  onCall: (phone: string) => void;
}) {
  const locationParts = [
    landlord.house_number && `House: ${landlord.house_number}`,
    landlord.cell && `Cell: ${landlord.cell}`,
    landlord.village && `Village: ${landlord.village}`,
    landlord.town_council && `Town Council: ${landlord.town_council}`,
    landlord.sub_county && `Sub-County: ${landlord.sub_county}`,
    landlord.county && `County: ${landlord.county}`,
    landlord.district && `District: ${landlord.district}`,
    landlord.region && `Region: ${landlord.region}`,
    landlord.country && `Country: ${landlord.country}`,
  ].filter(Boolean);

  return (
    <div className="p-4 space-y-4">
      {/* Header */}
      <div className="text-center space-y-2">
        <div className={cn(
          "mx-auto w-14 h-14 rounded-2xl flex items-center justify-center",
          landlord.verified ? "bg-success/10" : "bg-warning/10"
        )}>
          <Home className={cn("h-7 w-7", landlord.verified ? "text-success" : "text-warning")} />
        </div>
        <div>
          <h3 className="font-bold text-lg flex items-center justify-center gap-1.5">
            {landlord.name}
            {landlord.verified && <BadgeCheck className="h-5 w-5 text-success" />}
          </h3>
          <p className="text-sm text-muted-foreground">{landlord.property_address}</p>
        </div>
      </div>

      {/* Action buttons */}
      <div className="grid grid-cols-2 gap-2">
        {landlord.latitude && landlord.longitude && (
          <Button
            onClick={() => onNavigate(landlord.latitude!, landlord.longitude!)}
            className="gap-2"
            variant="default"
          >
            <Navigation className="h-4 w-4" />
            Navigate
          </Button>
        )}
        <Button onClick={() => onCall(landlord.phone)} variant="outline" className="gap-2">
          <Phone className="h-4 w-4" />
          Call
        </Button>
      </div>

      <Separator />

      {/* Property Details */}
      <div className="space-y-3">
        <h4 className="font-semibold text-sm">Property Info</h4>
        <div className="grid grid-cols-2 gap-2">
          {landlord.number_of_rooms && (
            <InfoCard label="Rooms" value={String(landlord.number_of_rooms)} icon={Home} />
          )}
          {landlord.number_of_houses && (
            <InfoCard label="Houses" value={String(landlord.number_of_houses)} icon={Building2} />
          )}
          {landlord.monthly_rent && (
            <InfoCard label="Rent" value={`UGX ${landlord.monthly_rent.toLocaleString()}`} icon={Building2} />
          )}
          {landlord.electricity_meter_number && (
            <InfoCard label="Electricity" value={landlord.electricity_meter_number} icon={Zap} />
          )}
          {landlord.water_meter_number && (
            <InfoCard label="Water" value={landlord.water_meter_number} icon={Droplets} />
          )}
        </div>
      </div>

      {/* Caretaker */}
      {landlord.caretaker_name && (
        <>
          <Separator />
          <div className="space-y-2">
            <h4 className="font-semibold text-sm">Caretaker</h4>
            <div className="flex items-center gap-3 p-3 rounded-xl bg-muted/50">
              <User className="h-5 w-5 text-muted-foreground" />
              <div className="flex-1">
                <p className="text-sm font-medium">{landlord.caretaker_name}</p>
                {landlord.caretaker_phone && (
                  <p className="text-xs text-muted-foreground">{landlord.caretaker_phone}</p>
                )}
              </div>
              {landlord.caretaker_phone && (
                <Button size="sm" variant="ghost" onClick={() => onCall(landlord.caretaker_phone!)}>
                  <Phone className="h-4 w-4" />
                </Button>
              )}
            </div>
          </div>
        </>
      )}

      {/* Location Hierarchy */}
      {locationParts.length > 0 && (
        <>
          <Separator />
          <div className="space-y-2">
            <h4 className="font-semibold text-sm flex items-center gap-1.5">
              <MapPin className="h-4 w-4" /> Location Details
            </h4>
            <div className="space-y-1">
              {locationParts.map((part, i) => (
                <div key={i} className="flex items-center gap-2 py-1.5 px-3 rounded-lg bg-muted/30 text-sm">
                  <span className="text-muted-foreground text-xs w-1.5 h-1.5 rounded-full bg-primary/40 shrink-0" />
                  {part}
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/* ── Small info card ── */
function InfoCard({ label, value, icon: Icon }: { label: string; value: string; icon: typeof Home }) {
  return (
    <div className="p-3 rounded-xl bg-muted/50 border border-border/50">
      <div className="flex items-center gap-1.5 mb-1">
        <Icon className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-[10px] text-muted-foreground uppercase tracking-wider">{label}</span>
      </div>
      <p className="text-sm font-medium truncate">{value}</p>
    </div>
  );
}
