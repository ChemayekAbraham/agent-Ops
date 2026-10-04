import { MapPin, GraduationCap, Stethoscope, ShoppingCart, Bus } from 'lucide-react';

interface NearbyAmenitiesProps {
  latitude: number | null;
  longitude: number | null;
}

const AMENITY_TYPES = [
  { key: 'school', label: 'Schools', icon: GraduationCap, query: 'schools' },
  { key: 'hospital', label: 'Health', icon: Stethoscope, query: 'hospitals+clinics' },
  { key: 'market', label: 'Markets', icon: ShoppingCart, query: 'markets+supermarkets' },
  { key: 'transport', label: 'Transport', icon: Bus, query: 'bus+station+boda+stage' },
];

export default function NearbyAmenities({ latitude, longitude }: NearbyAmenitiesProps) {
  if (!latitude || !longitude) return null;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <MapPin className="h-4 w-4 text-primary" />
        <h2 className="font-bold text-base">Nearby</h2>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {AMENITY_TYPES.map(a => (
          <a
            key={a.key}
            href={`https://www.google.com/maps/search/${a.query}/@${latitude},${longitude},15z`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 p-2.5 rounded-xl border border-border/50 bg-card hover:bg-muted/50 transition-colors"
          >
            <div className="h-8 w-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
              <a.icon className="h-4 w-4 text-primary" />
            </div>
            <div>
              <p className="text-xs font-medium">{a.label}</p>
              <p className="text-[10px] text-muted-foreground">View on map →</p>
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}
